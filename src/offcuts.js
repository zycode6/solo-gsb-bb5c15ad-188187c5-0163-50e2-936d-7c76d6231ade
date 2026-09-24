'use strict';

/**
 * 余料库存与复用预占（offcut inventory & allocation）
 *
 * 把排料结果中每张纸 layout.frees 的自由矩形标准化为可追踪的余料记录
 * （保留纸型宽高/名称、纸张纹向、刀缝、纸面坐标、尺寸与来源批次），
 * 支持：
 *  - 余料录入（手工录入 / 从单张、批量、多纸型成本、方案比选结果批量登记；
 *    批量登记先校验全部待登记余料，再按来源指纹去重，最后一次性写入——
 *    任一余料无效时库存、预占状态与自动生成的余料/批次序号均不变）；
 *  - 余料查询（可用 / 已预占、最小尺寸、关键字）；
 *  - POST /api/offcuts/allocate 原子复用预占：给定成品宽高、数量与纹向要求，
 *    按旋转 / 纹向可行性与“占用后剩余面积最小”确定性选取余料；
 *    一次请求必须预占足量余料，无法满足时不改动任何记录并返回缺口明细；
 *  - 释放预占（按预占单号 / 余料编号）。
 *
 * 持久化提交（手工录入、结果登记、预占、释放统一路径）：
 *  每次变更都先在状态副本（draft）中完成全部校验与自动编号（余料 OC 号、
 *  预占 AL 号、来源批次 BATCH 号），随后把副本原子写入本地快照
 *  （临时文件 fsync + rename）；只有写盘成功后，副本才发布为当前库存状态。
 *  写盘失败抛出 SnapshotError（HTTP 500），当前库存与三个自动编号均不前进。
 *
 * 服务启动时调用 initPersistence(snapshotFile) 恢复余料、预占关系与三个序号；
 * 快照文件存在但内容损坏（结构 / 字段 / 编号一致性不符，或预占记录的成品尺寸
 * 与旋转后放置宽高不一致、放置越出余料边界、纸张与成品纹向不允许该朝向）时
 * 明确抛错（指出余料编号）拒绝启动，不发布半恢复库存，避免把既有库存当作
 * 空库继续写入。恢复后同批次重复登记仍按来源指纹去重。
 * 未配置快照文件（如单元测试）时退化为纯进程内存模式。
 *
 * 落盘精度（手工录入与结果登记共用的记录构造路径统一执行）：
 * 纸面宽高、刀缝、纸面坐标与余料宽高一律先舍入到 0.001mm（round3），
 * 再对舍入后的落盘值做几何校验（正数、坐标非负、不越出纸面），
 * 面积由舍入后的宽×高计算——快照中纸面、坐标、宽高与面积因此彼此自洽，
 * 重启恢复按同一组数值重算必然通过；查询与预占读取的也是这组落盘尺寸。
 * 正数尺寸舍入后为零（如 0.0004）或舍入后越出纸面的输入明确报错（HTTP 400），
 * 不会写入重启后必然被拒绝的快照。
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  normalizePaperGrain,
  normalizeProductGrain,
  grainAllows,
} = require('./packer');

const EPS = 1e-6;
const SNAPSHOT_APP = 'sheet-layout/offcuts';
const SNAPSHOT_VERSION = 1;

/** 落盘精度：所有持久化的尺寸 / 坐标 / 面积统一舍入到 0.001（mm） */
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * 正数尺寸按落盘精度舍入；舍入后为零时明确报错——
 * 否则快照会留下 0 尺寸记录，重启恢复必然被几何校验拒绝。
 */
function roundPersisted(value, subject) {
  const r = round3(value);
  if (!(r > 0)) {
    throw new Error(`${subject}按 0.001mm 精度舍入后为零（原值 ${value}），`
      + '请使用不小于 0.001 的尺寸');
  }
  return r;
}

/* ---------------- 存储状态 ---------------- */

/** 初始（空）状态：三个自动序号 + 余料表（id → 记录） */
function initialState() {
  return {
    seq: 0, // 余料记录序号
    allocSeq: 0, // 预占单号序号
    batchSeq: 0, // 自动来源批次序号
    offcuts: new Map(), // id → 记录
  };
}

/** 当前已发布的库存状态；所有读取仅针对它，变更只在快照写盘成功后发布 */
let store = initialState();

/** 快照文件绝对路径；null 表示纯内存模式（未配置持久化） */
let snapshotFile = null;

/** 仅供测试：回到空库；可选 snapshot 参数切换快照文件，null 表示纯内存 */
function _resetStore(snapshot = undefined) {
  store = initialState();
  if (snapshot !== undefined) snapshotFile = snapshot || null;
}

/** 仅供测试：只切换快照文件，不动当前库存（模拟写盘目标变为不可写） */
function _setSnapshotFile(file) {
  snapshotFile = file || null;
}

/**
 * 深拷贝当前状态用于“先改副本后提交”：记录对象必须一并复制，
 * 否则副本中对 rec.status / rec.reservation 的修改会渗透到已发布库存，
 * 写盘失败时库存看起来已被改动。
 */
function cloneState(state) {
  return {
    seq: state.seq,
    allocSeq: state.allocSeq,
    batchSeq: state.batchSeq,
    offcuts: new Map(
      [...state.offcuts.entries()].map(([id, rec]) => [id, structuredClone(rec)])
    ),
  };
}

function newOffcutId(state) {
  state.seq += 1;
  return `OC-${String(state.seq).padStart(6, '0')}`;
}

function newAllocationId(state) {
  state.allocSeq += 1;
  return `AL-${String(state.allocSeq).padStart(6, '0')}`;
}

function newBatchId(state) {
  state.batchSeq += 1;
  return `BATCH-${String(state.batchSeq).padStart(6, '0')}`;
}

/* ---------------- 本地快照：原子写盘 / 启动恢复 ---------------- */

/** 写盘失败专用错误：调用方据此返回服务错误（HTTP 500）而非输入错误 */
class SnapshotError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'SnapshotError';
    this.statusCode = 500;
    if (cause) this.cause = cause;
  }
}

function serializeState(state) {
  return {
    app: SNAPSHOT_APP,
    version: SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    seq: state.seq,
    allocSeq: state.allocSeq,
    batchSeq: state.batchSeq,
    offcuts: [...state.offcuts.values()],
  };
}

/**
 * 原子写入快照：先写同目录临时文件并 fsync，再 rename 覆盖正式文件。
 * 任一步失败都抛出 SnapshotError；调用方保证不发布已在副本中完成的变更。
 */
function writeSnapshot(state) {
  if (!snapshotFile) return;
  let tmpFd = null;
  const tmpFile = `${snapshotFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    tmpFd = fs.openSync(tmpFile, 'w', 0o600);
    fs.writeSync(tmpFd, JSON.stringify(serializeState(state), null, 2));
    fs.fsyncSync(tmpFd);
    fs.closeSync(tmpFd);
    tmpFd = null;
    fs.renameSync(tmpFile, snapshotFile);
    // 尽力把目录项变更落盘（个别平台/文件系统不支持目录 fsync，忽略即可）
    let dirFd = null;
    try {
      dirFd = fs.openSync(path.dirname(snapshotFile), 'r');
      fs.fsyncSync(dirFd);
    } catch {
      /* 目录 fsync 为耐久性增强，不支持时忽略 */
    } finally {
      if (dirFd != null) { try { fs.closeSync(dirFd); } catch { /* 忽略 */ } }
    }
  } catch (err) {
    if (tmpFd != null) { try { fs.closeSync(tmpFd); } catch { /* 忽略 */ } }
    try { fs.unlinkSync(tmpFile); } catch { /* 临时文件尚未生成时忽略 */ }
    throw new SnapshotError(`库存快照写入失败（${snapshotFile}）：库存未变更`, err);
  }
}

/**
 * 持久化提交：在已完成校验与编号的状态副本上先原子写盘，成功后才发布。
 * @returns 发布后的新状态（后续返回值中的汇总应基于它）
 */
function commitState(next) {
  writeSnapshot(next);
  store = next;
  return store;
}

function snapInvalid(msg) {
  return new Error(`库存快照损坏，拒绝启动（${snapshotFile || '未配置快照文件'}）：${msg}`);
}

function snapNumber(value, subject) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw snapInvalid(`${subject}必须是非负整数`);
  }
  return value;
}

function snapFinite(value, subject) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw snapInvalid(`${subject}必须是数字`);
  }
  return value;
}

function snapString(value, subject) {
  if (typeof value !== 'string') throw snapInvalid(`${subject}必须是字符串`);
  return value;
}

function snapNullableString(value, subject) {
  if (value != null && typeof value !== 'string') throw snapInvalid(`${subject}必须是字符串或 null`);
  return value == null ? null : value;
}

function snapNullableInteger(value, subject) {
  if (value != null && (typeof value !== 'number' || !Number.isInteger(value))) {
    throw snapInvalid(`${subject}必须是整数或 null`);
  }
  return value == null ? null : value;
}

/**
 * 校验并解析快照内容：任何结构 / 字段 / 编号一致性不符都视为损坏；
 * 已预占记录额外核对——成品尺寸与按 rotated 旋转后的放置宽高一致、
 * 放置不越出余料边界、纸张与成品纹向允许该朝向（与预占时判定规则相同）。
 * 任一不符指出余料编号并整体抛错，调用方不会发布半恢复库存。
 */
function parseSnapshot(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw snapInvalid(`不是合法 JSON（${err.message}）`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw snapInvalid('顶层必须是对象');
  }
  if (data.app !== SNAPSHOT_APP) throw snapInvalid(`app 标识必须为 ${SNAPSHOT_APP}`);
  if (data.version !== SNAPSHOT_VERSION) {
    throw snapInvalid(`不支持的快照版本 ${JSON.stringify(data.version)}（期望 ${SNAPSHOT_VERSION}）`);
  }
  if (!Array.isArray(data.offcuts)) throw snapInvalid('offcuts 必须是数组');

  const state = initialState();
  state.seq = snapNumber(data.seq, 'seq');
  state.allocSeq = snapNumber(data.allocSeq, 'allocSeq');
  state.batchSeq = snapNumber(data.batchSeq, 'batchSeq');

  let maxOc = 0;
  let maxAl = 0;
  const knownAllocations = new Set();
  const seenIds = new Set();

  data.offcuts.forEach((rec, i) => {
    const at = `第 ${i + 1} 条余料`;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      throw snapInvalid(`${at}必须是对象`);
    }
    const id = snapString(rec.id, `${at}编号 id`);
    const m = id.match(/^OC-(\d+)$/);
    if (!m) throw snapInvalid(`${at}编号格式非法：${id}`);
    if (seenIds.has(id)) throw snapInvalid(`余料编号重复：${id}`);
    seenIds.add(id);
    const ocNum = Number(m[1]);
    maxOc = Math.max(maxOc, ocNum);

    if (!['available', 'reserved'].includes(rec.status)) {
      throw snapInvalid(`${at}（${id}）状态必须是 available 或 reserved`);
    }
    snapNullableString(rec.paperName, `${at}纸型名称`);
    const paperWidth = snapFinite(rec.paperWidth, `${at}纸张宽`);
    const paperHeight = snapFinite(rec.paperHeight, `${at}纸张高`);
    if (!(paperWidth > 0) || !(paperHeight > 0)) {
      throw snapInvalid(`${at}（${id}）纸张宽高必须为正`);
    }
    if (!['along-width', 'along-height'].includes(rec.paperGrain)) {
      throw snapInvalid(`${at}（${id}）纸张纹向非法`);
    }
    const kerf = snapFinite(rec.kerf, `${at}刀缝`);
    if (kerf < 0) throw snapInvalid(`${at}（${id}）刀缝不能为负`);
    const x = snapFinite(rec.x, `${at}坐标 x`);
    const y = snapFinite(rec.y, `${at}坐标 y`);
    const w = snapFinite(rec.w, `${at}余料宽`);
    const h = snapFinite(rec.h, `${at}余料高`);
    const area = snapFinite(rec.area, `${at}面积`);
    if (x < 0 || y < 0 || w <= 0 || h <= 0) {
      throw snapInvalid(`${at}（${id}）坐标不能为负、尺寸必须为正`);
    }
    if (x + w > paperWidth + EPS || y + h > paperHeight + EPS) {
      throw snapInvalid(`${at}（${id}）余料矩形超出纸面范围`);
    }
    if (Math.abs(area - round3(w * h)) > 1e-3) {
      throw snapInvalid(`${at}（${id}）面积与宽×高不一致`);
    }

    if (!rec.source || typeof rec.source !== 'object') {
      throw snapInvalid(`${at}（${id}）缺少来源信息 source`);
    }
    if (!['single', 'batch', 'cost', 'manual'].includes(rec.source.type)) {
      throw snapInvalid(`${at}（${id}）来源类型非法：${rec.source.type}`);
    }
    snapNullableString(rec.source.batchId, `${at}来源批次号`);
    snapNullableInteger(rec.source.sheetIndex, `${at}纸张序号`);
    snapNullableInteger(rec.source.round, `${at}轮次`);
    snapNullableString(rec.source.paperId, `${at}纸型 id`);
    snapNullableString(rec.source.orderNo, `${at}订单号`);
    snapNullableString(rec.source.ingestedAt, `${at}登记时间`);
    if (rec.source.note != null && typeof rec.source.note !== 'string') {
      throw snapInvalid(`${at}（${id}）备注必须是字符串`);
    }

    if (rec.status === 'reserved') {
      const rv = rec.reservation;
      if (!rv || typeof rv !== 'object') {
        throw snapInvalid(`${at}（${id}）状态为已预占但缺少预占信息 reservation`);
      }
      const aid = snapString(rv.allocationId, `${at}预占单号`);
      const am = aid.match(/^AL-(\d+)$/);
      if (!am) throw snapInvalid(`${at}（${id}）预占单号格式非法：${aid}`);
      maxAl = Math.max(maxAl, Number(am[1]));
      knownAllocations.add(aid);
      if (!rv.product || typeof rv.product !== 'object') {
        throw snapInvalid(`${at}（${id}）预占信息缺少成品尺寸 product`);
      }
      const productW = snapFinite(rv.product.width, `${at}预占成品宽`);
      const productH = snapFinite(rv.product.height, `${at}预占成品高`);
      if (!(productW > 0) || !(productH > 0)) {
        throw snapInvalid(`${at}（${id}）预占成品宽高必须为正`);
      }
      if (!['any', 'along-width', 'along-height'].includes(rv.product.grain)) {
        throw snapInvalid(`${at}（${id}）预占成品纹向非法`);
      }
      if (typeof rv.rotated !== 'boolean') throw snapInvalid(`${at}（${id}）rotated 必须是布尔值`);
      const placedW = snapFinite(rv.placedW, `${at}预占放置宽`);
      const placedH = snapFinite(rv.placedH, `${at}预占放置高`);
      if (!(placedW > 0) || !(placedH > 0)) {
        throw snapInvalid(`${at}（${id}）预占放置宽高必须为正`);
      }
      // 一致性核对（与 allocateInState 写入预占时的规则相同）：
      // 放置宽高必须等于成品尺寸按 rotated 旋转后的结果（旋转 90° 时宽高互换）
      const expectW = rv.rotated ? productH : productW;
      const expectH = rv.rotated ? productW : productH;
      if (Math.abs(placedW - expectW) > 1e-3 || Math.abs(placedH - expectH) > 1e-3) {
        throw snapInvalid(`${at}（${id}）预占放置宽高 ${placedW}×${placedH} 与成品尺寸 `
          + `${productW}×${productH}（rotated=${rv.rotated}）不一致`);
      }
      // 放置必须落在余料矩形内（越界预占会让库存台账失真）
      if (placedW > w + EPS || placedH > h + EPS) {
        throw snapInvalid(`${at}（${id}）预占放置尺寸 ${placedW}×${placedH} 超出余料范围 ${w}×${h}`);
      }
      // 纸张纹向与成品纹向要求必须允许该朝向（平行规则，同 feasiblePlacement）
      if (!grainAllows(rv.product.grain, rec.paperGrain, rv.rotated)) {
        throw snapInvalid(`${at}（${id}）预占朝向不满足纸张纹向 ${rec.paperGrain} `
          + `与成品纹向要求 ${rv.product.grain} 的平行规则`);
      }
      snapNullableString(rv.ref, `${at}关联单据`);
      snapString(rv.createdAt, `${at}预占时间`);
    } else if (rec.reservation != null) {
      throw snapInvalid(`${at}（${id}）状态为可用但仍带预占信息 reservation`);
    }

    state.offcuts.set(id, rec);
  });

  // 编号一致性：序号必须覆盖库存中出现过的最大编号，防止恢复后编号回退/碰撞
  if (state.seq !== maxOc) {
    throw snapInvalid(`余料序号 seq=${state.seq} 与库存最大编号 OC-${String(maxOc).padStart(6, '0')} 不一致`);
  }
  if (state.allocSeq < maxAl) {
    throw snapInvalid(`预占序号 allocSeq=${state.allocSeq} 小于已存在的最大预占单号 AL-${String(maxAl).padStart(6, '0')}`);
  }

  // 自动批次号 BATCH- 前缀的序号同样不得越过 batchSeq
  for (const rec of state.offcuts.values()) {
    const b = rec.source.batchId;
    if (typeof b === 'string') {
      const bm = b.match(/^BATCH-(\d+)$/);
      if (bm && Number(bm[1]) > state.batchSeq) {
        throw snapInvalid(`批次序号 batchSeq=${state.batchSeq} 小于已存在的来源批次 ${b}`);
      }
    }
  }

  return { state, offcutCount: state.offcuts.size, allocationIds: [...knownAllocations].sort() };
}

/**
 * 配置并恢复持久化（服务启动时调用一次）。
 *  - snapshotFile 为 null/空：纯进程内存模式，从空库开始；
 *  - 文件不存在：预检父目录可写后从空库开始（首次启动，首个变更时生成快照）；
 *  - 文件存在但损坏：抛错拒绝启动，绝不把既有库存当作空库；
 *  - 父路径不可写 / 不是目录：抛错拒绝启动，避免服务起来后每次写盘才 500。
 * @returns {{ restored:boolean, offcutCount:number, allocationIds:string[] }|null}
 */
function initPersistence(file) {
  snapshotFile = file ? path.resolve(file) : null;
  if (!snapshotFile) return null;

  // 预检快照路径：快照文件本身若存在，不能是目录
  let stat;
  try {
    stat = fs.statSync(snapshotFile);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new SnapshotError(`库存快照路径无法访问（${snapshotFile}），拒绝启动`, err);
    }
  }
  if (stat && stat.isDirectory()) {
    throw new SnapshotError(`库存快照路径是目录而非文件（${snapshotFile}），拒绝启动`);
  }

  const dir = path.dirname(snapshotFile);

  if (!stat) {
    // 首次启动：确保快照目录存在（如本地运行默认的 ./data），首个变更时生成快照
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
      throw new SnapshotError(`库存快照目录无法创建或不可写（${dir}），拒绝启动`, err);
    }
    store = initialState();
    return { restored: false, offcutCount: 0, allocationIds: [] };
  }

  // 快照已存在：父目录必须存在、是目录且可读，随后校验内容
  let dirStat;
  try {
    dirStat = fs.statSync(dir);
  } catch (err) {
    throw new SnapshotError(`库存快照目录无法访问（${dir}），拒绝启动`, err);
  }
  if (!dirStat.isDirectory()) {
    throw new SnapshotError(`库存快照父路径不是目录（${dir}），拒绝启动`);
  }

  let raw;
  try {
    raw = fs.readFileSync(snapshotFile, 'utf8');
  } catch (err) {
    throw new SnapshotError(`库存快照无法读取（${snapshotFile}），拒绝启动`, err);
  }
  const parsed = parseSnapshot(raw);
  store = parsed.state;
  return { restored: true, offcutCount: parsed.offcutCount, allocationIds: parsed.allocationIds };
}

/* ---------------- 输入校验 ---------------- */

function positiveNumber(value, subject) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${subject}必须为正数`);
  return n;
}

function nonNegativeNumber(value, subject) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${subject}必须是非负数字`);
  return n;
}

function positiveInteger(value, subject, max = 100000) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${subject}必须是正整数`);
  if (n > max) throw new Error(`${subject}不能超过 ${max}`);
  return n;
}

function normalizeRef(value, subject = '关联单据') {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 128) throw new Error(`${subject}长度不能超过 128 个字符`);
  return s;
}

/** 校验显式来源批次号；未提供时返回 null（是否自动生成由调用方决定时机） */
function explicitBatchId(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 128) throw new Error('来源批次号长度不能超过 128 个字符');
  return s;
}

/** 规范化单条余料的纸型 / 几何字段（手工录入与结果登记共用） */
function normalizeOffcutShape(raw, pos) {
  const who = pos ? `第 ${pos} 条余料的` : '';
  const width = roundPersisted(positiveNumber(raw.width, `${who}宽度`), `${who}宽度`);
  const height = roundPersisted(positiveNumber(raw.height, `${who}高度`), `${who}高度`);
  const kerf = raw.kerf == null || raw.kerf === ''
    ? 0
    : round3(nonNegativeNumber(raw.kerf, `${who}刀缝宽度`));
  const paperGrain = normalizePaperGrain(raw.paperGrain || raw.grain, '余料纸张');
  return { width, height, kerf, paperGrain };
}

/* ---------------- 记录构造 ---------------- */

/**
 * 校验并规范化一个自由矩形的坐标与尺寸（纯校验，不取号、不写库）。
 * 坐标与尺寸先舍入到落盘精度（0.001mm），几何校验针对舍入后的落盘值：
 * 正数尺寸舍入后为零、坐标为负或矩形越出（同样已舍入的）纸面均明确报错，
 * 保证通过校验的值与最终快照持久化的值完全一致。
 * @param {object} free { x, y, w, h }（layout.frees 元素）
 * @param {object} paper { width, height }（已规范化的纸张）
 * @returns {{ x:number, y:number, w:number, h:number }}
 */
function normalizeFreeRect(free, paper) {
  const paperW = round3(paper.width);
  const paperH = round3(paper.height);
  const x = round3(Number(free.x) || 0);
  const y = round3(Number(free.y) || 0);
  const w = roundPersisted(positiveNumber(free.w, '余料宽度'), '余料宽度');
  const h = roundPersisted(positiveNumber(free.h, '余料高度'), '余料高度');
  if (x < 0 || y < 0) throw new Error('余料坐标不能为负');
  if (x + w > paperW + EPS || y + h > paperH + EPS) {
    throw new Error('余料矩形超出纸面范围');
  }
  return { x, y, w, h };
}

/**
 * 由已校验的自由矩形构造余料记录。
 * rect 与 paper 的尺寸 / 坐标均已按落盘精度舍入（见 normalizeFreeRect /
 * normalizeLayoutPaper / normalizeOffcutShape），此处 round3 为幂等兜底；
 * 面积由舍入后的宽×高计算，与快照恢复时按存储宽高重算的结果一致，
 * 保证纸面、坐标、宽高与面积在快照中自洽。
 * id 留空（null），由调用方在确定入库时通过 newOffcutId(state) 赋值，
 * 保证跳过的重复项与校验失败的批次不消耗余料序号。
 * @param {object} rect { x, y, w, h }（normalizeFreeRect 返回）
 * @param {object} paper { width, height, kerf, grain }
 * @param {object} meta { type, batchId, sheetIndex, round, paperId, paperName, orderNo }
 */
function buildRecord(rect, paper, meta) {
  const { x, y, w, h } = rect;
  return {
    id: null,
    paperName: meta.paperName || null,
    paperWidth: round3(paper.width),
    paperHeight: round3(paper.height),
    paperGrain: paper.grain,
    kerf: round3(paper.kerf),
    x: round3(x),
    y: round3(y),
    w: round3(w),
    h: round3(h),
    area: round3(w * h),
    status: 'available', // available（可用） | reserved（已预占）
    source: {
      type: meta.type, // single | batch | cost | manual
      batchId: meta.batchId || null,
      sheetIndex: meta.sheetIndex == null ? null : meta.sheetIndex,
      round: meta.round == null ? null : meta.round,
      paperId: meta.paperId || null,
      orderNo: meta.orderNo == null ? null : meta.orderNo,
      ingestedAt: new Date().toISOString(),
    },
    reservation: null,
  };
}

/**
 * 把一个自由矩形标准化为余料记录（校验 + 取号，作用于指定状态；
 * 仅供不经持久化提交的直接调用路径 offcutsFromLayout 使用）。
 * @param {object} free { x, y, w, h }（layout.frees 元素）
 * @param {object} paper { width, height, kerf, grain }（layout.paper）
 * @param {object} meta { type, batchId, sheetIndex, round, paperId, paperName, orderNo }
 */
function buildRecordFromFree(free, paper, meta, state = store) {
  const rec = buildRecord(normalizeFreeRect(free, paper), paper, meta);
  rec.id = newOffcutId(state);
  return rec;
}

/* ---------------- 从排料结果登记 ---------------- */

/** 规范化排料结果中的纸张信息（单张 / 批量 / 成本 / 比选登记共用） */
function normalizeLayoutPaper(layoutResult) {
  if (!layoutResult || typeof layoutResult !== 'object' || !layoutResult.paper) {
    throw new Error('缺少有效的单张排料结果（需包含 paper 与 frees）');
  }
  return {
    width: roundPersisted(positiveNumber(layoutResult.paper.width, '纸张宽度'), '纸张宽度'),
    height: roundPersisted(positiveNumber(layoutResult.paper.height, '纸张高度'), '纸张高度'),
    kerf: layoutResult.paper.kerf == null
      ? 0
      : round3(nonNegativeNumber(layoutResult.paper.kerf, '刀缝宽度')),
    grain: normalizePaperGrain(layoutResult.paper.grain, '纸张'),
  };
}

/** 从单张 layout() 结果提取余料记录（便捷方法：直接取号写入当前内存状态） */
function offcutsFromLayout(layoutResult, meta) {
  const paper = normalizeLayoutPaper(layoutResult);
  const frees = Array.isArray(layoutResult.frees) ? layoutResult.frees : [];
  return frees.map((free) => buildRecordFromFree(free, paper, meta));
}

/**
 * 识别排料结果形态：
 *  - sheets[].layout 存在 → cost（多纸型成本排产）
 *  - sheets 存在         → batch（批量排产）
 *  - candidates 存在     → compare（方案比选，登记当前/最佳候选）
 *  - paper + frees       → single（单张排样）
 */
function detectResultShape(raw) {
  if (Array.isArray(raw.sheets)) {
    return raw.sheets.length && raw.sheets[0] && raw.sheets[0].layout ? 'cost' : 'batch';
  }
  if (Array.isArray(raw.candidates)) return 'compare';
  if (raw.paper && Array.isArray(raw.frees)) return 'single';
  return null;
}

/**
 * 在给定状态上执行结果登记的全部校验、去重与编号（不发布、不写盘）。
 * 拆出便于 ingestOffcuts 在状态副本上调用。
 */
function ingestIntoState(state, input) {
  if (!input || typeof input !== 'object') throw new Error('缺少排料结果');
  const raw = input.layout || input.result || input.data || input;
  const shape = detectResultShape(raw);
  if (!shape) {
    throw new Error('无法识别排料结果（需为单张 layout.frees、批量/成本 sheets 或方案比选 candidates）');
  }
  // 显式批次号先校验格式；缺省时的自动批次号留待全部校验通过后再取号，
  // 保证任一余料无效时批次序号不前进
  const givenBatchId = explicitBatchId(input.batchId);

  const plans = []; // [{ layout, meta }]（meta.batchId 待批次号确定后统一填入）
  if (shape === 'single') {
    plans.push({
      layout: raw,
      meta: { type: 'single', sheetIndex: 1 },
    });
  } else if (shape === 'compare') {
    // 方案比选：登记中选方案；全部排不进（best 为 null）时登记首个候选
    const chosen = raw.best
      ? raw.best.layout
      : (raw.candidates[0] && raw.candidates[0].layout);
    if (!chosen) throw new Error('方案比选结果中没有可登记的布局');
    plans.push({
      layout: chosen,
      meta: { type: 'single', sheetIndex: 1 },
    });
  } else if (shape === 'batch') {
    raw.sheets.forEach((sh, i) => {
      plans.push({
        layout: sh,
        meta: {
          type: 'batch', sheetIndex: i + 1,
          round: sh.round || i + 1, orderNo: sh.orderNo == null ? null : sh.orderNo,
        },
      });
    });
  } else {
    raw.sheets.forEach((sh, i) => {
      plans.push({
        layout: sh.layout,
        meta: {
          type: 'cost', sheetIndex: i + 1,
          round: sh.round, paperId: sh.paperId, paperName: sh.paperName,
          orderNo: sh.orderNo == null ? null : sh.orderNo,
        },
      });
    });
  }

  // 第一阶段：校验全部纸张与待登记余料（纯校验，不取号、不写库）
  const pending = []; // [{ rect, paper, meta }]
  for (const plan of plans) {
    const paper = normalizeLayoutPaper(plan.layout);
    const frees = Array.isArray(plan.layout.frees) ? plan.layout.frees : [];
    for (const free of frees) {
      pending.push({ rect: normalizeFreeRect(free, paper), paper, meta: plan.meta });
    }
  }

  // 全部校验通过后才确定来源批次号（缺省时此刻才消耗自动批次序号）
  const batchId = givenBatchId || newBatchId(state);

  // 第二阶段：同一来源（批次 + 纸张序号）下纸型、刀缝、坐标、尺寸完全相同的
  // 余料不重复登记；跨请求对同一 batchId 重复提交同样去重（保持原有登记顺序）
  const fingerprints = new Set();
  for (const rec of state.offcuts.values()) fingerprints.add(fingerprintOf(rec));

  const seen = new Set(); // 本次请求内的指纹（与库内指纹一并判重）
  const accepted = [];
  let skipped = 0;
  for (const item of pending) {
    const rec = buildRecord(item.rect, item.paper, { ...item.meta, batchId });
    const fp = fingerprintOf(rec);
    if (seen.has(fp) || fingerprints.has(fp)) {
      skipped += 1;
      continue;
    }
    seen.add(fp);
    accepted.push(rec);
  }

  // 第三阶段：一次性取号（只有确定入库的记录才消耗余料序号）；
  // 发布与否由调用方（持久化提交）决定
  const ingested = [];
  for (const rec of accepted) {
    rec.id = newOffcutId(state);
    state.offcuts.set(rec.id, rec);
    ingested.push(rec);
  }

  return {
    batchId,
    shape,
    ingested: ingested.length,
    skipped,
    offcutIds: ingested.map((r) => r.id),
  };
}

/**
 * 从排料结果批量登记余料。接受请求体中的 layout / result / data 字段，
 * 也可直接把单张 / 批量 / 成本 / 比选返回作为请求体。
 * 同一来源批次（batchId）下纸型、刀缝、坐标、尺寸完全相同的余料不重复登记。
 *
 * 原子性：先在状态副本中校验全部待登记余料（任一无效即整体报错），再按来源
 * 指纹处理库内与本次请求内的重复项，最后一次性取号并原子写盘；写盘成功后
 * 才发布。任一余料无效或写盘失败时，库存、预占状态与自动生成的余料/批次
 * 序号均不变，修正后重试不会出现跳过记录或编号错位。
 *
 * @returns {{ batchId, ingested:number, skipped:number, offcutIds:string[], summary }}
 */
function ingestOffcuts(input) {
  const draft = cloneState(store);
  const result = ingestIntoState(draft, input);
  commitState(draft);
  return { ...result, summary: inventorySummary(store) };
}

/* ---------------- 手工录入 ---------------- */

/**
 * 在给定状态上完成手工录入的校验、批次取号与余料取号（不发布、不写盘）。
 */
function createOffcutInState(state, input) {
  if (!input || typeof input !== 'object') throw new Error('缺少余料信息');
  const shape = normalizeOffcutShape(input);
  const paperName = input.paperName != null ? String(input.paperName).trim() : '';
  const orderNo = normalizeRef(input.orderNo, '订单号');
  const givenBatchId = explicitBatchId(input.batchId);
  const free = { x: 0, y: 0, w: shape.width, h: shape.height };
  const rec = buildRecord(normalizeFreeRect(free, {
    width: shape.width,
    height: shape.height,
  }), {
    width: shape.width,
    height: shape.height,
    kerf: shape.kerf,
    grain: shape.paperGrain,
  }, {
    type: 'manual',
    batchId: givenBatchId || newBatchId(state),
    sheetIndex: null,
    paperName: paperName || null,
    orderNo,
  });
  if (input.note != null && input.note !== '') rec.source.note = String(input.note).slice(0, 256);
  rec.id = newOffcutId(state);
  state.offcuts.set(rec.id, rec);
  return rec;
}

/**
 * 手工录入一条余料（切下后留存的矩形，无原纸面坐标时坐标取 0,0）。
 * 先在状态副本完成校验与编号，原子写盘成功后才发布；写盘失败返回服务错误，
 * 库存与三个自动编号均不前进。
 * @param {object} input { paperName?, width, height, paperGrain?|grain?, kerf?, batchId?, orderNo?, note? }
 */
function createOffcut(input) {
  const draft = cloneState(store);
  const rec = createOffcutInState(draft, input);
  commitState(draft);
  return { offcut: rec, summary: inventorySummary(store) };
}

/* ---------------- 查询 ---------------- */

function inventorySummary(state = store) {
  let available = 0;
  let reserved = 0;
  let availableArea = 0;
  let reservedArea = 0;
  for (const rec of state.offcuts.values()) {
    if (rec.status === 'reserved') {
      reserved += 1;
      reservedArea += rec.area;
    } else {
      available += 1;
      availableArea += rec.area;
    }
  }
  return {
    total: state.offcuts.size,
    available,
    reserved,
    availableArea: round3(availableArea),
    reservedArea: round3(reservedArea),
    totalArea: round3(availableArea + reservedArea),
  };
}

/**
 * 汇总当前全部已预占余料并按预占单分组（不套用任何列表筛选）。
 *
 * 同一预占单可能含尺寸差异较大的多块余料；列表的最小尺寸 / 纹向 / 关键字 /
 * 状态筛选只应裁剪明细，绝不能裁剪分组：组内编号、总块数与「释放该预占」
 * 始终对应整单。明细全部被筛选掉时分组仍需可见，故该分组独立于查询明细计算。
 * 与明细列表同一次库存读取（同一 store 快照），保证两组数据彼此一致。
 *
 * 组按预占单号升序、组内余料按编号升序，输出确定。
 */
function allocationGroups(state = store) {
  const groups = new Map(); // allocationId → { offcuts: [] }
  for (const rec of state.offcuts.values()) {
    if (rec.status !== 'reserved') continue;
    const aid = rec.reservation.allocationId;
    if (!groups.has(aid)) groups.set(aid, []);
    groups.get(aid).push(rec);
  }
  return [...groups.entries()]
    .sort((a, b) => allocationSeq(a[0]) - allocationSeq(b[0]))
    .map(([allocationId, offcuts]) => {
      offcuts.sort((a, b) => offcutSeq(a.id) - offcutSeq(b.id));
      const r0 = offcuts[0].reservation;
      return {
        allocationId,
        product: r0.product,
        ref: r0.ref,
        createdAt: r0.createdAt,
        count: offcuts.length,
        offcuts,
      };
    });
}

/**
 * 查询余料。
 * @param {object} query
 *   status?: 'all'（缺省）| 'available' | 'reserved'
 *   minW?, minH?: 要求余料某种朝向下至少能容纳 minW×minH
 *   grain?: 仅返回该纸张纹向的余料
 *   q?: 关键字（纸型名称 / 来源批次 / 订单号）
 * @returns {{ summary, count, offcuts, allocationGroups }}
 *   offcuts 遵循全部筛选条件；allocationGroups 为同次库存读取下的完整已预占单
 *   分组（不随筛选裁剪），组内总块数与释放范围始终对应整单。
 */
function listOffcuts(query = {}) {
  const status = query.status == null || query.status === '' ? 'all' : String(query.status);
  if (!['all', 'available', 'reserved'].includes(status)) {
    throw new Error('状态筛选必须是 all、available 或 reserved');
  }
  const minW = query.minW == null || query.minW === '' ? null : positiveNumber(query.minW, '最小宽');
  const minH = query.minH == null || query.minH === '' ? null : positiveNumber(query.minH, '最小高');
  let grain = null;
  if (query.grain != null && query.grain !== '') grain = normalizePaperGrain(query.grain, '筛选纹向');
  const kw = query.q != null ? String(query.q).trim().toLowerCase() : '';

  const fitsMin = (rec) => {
    if (minW == null) return true;
    // 允许旋转 90° 比较
    return (rec.w >= minW - EPS && rec.h >= minH - EPS)
      || (rec.w >= minH - EPS && rec.h >= minW - EPS);
  };

  const list = [];
  for (const rec of store.offcuts.values()) {
    if (status !== 'all' && rec.status !== status) continue;
    if (grain && rec.paperGrain !== grain) continue;
    if (!fitsMin(rec)) continue;
    if (kw) {
      const hay = [rec.paperName, rec.source.batchId, rec.source.orderNo, rec.id]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    list.push(rec);
  }

  // 确定性排序：可用优先（查询已固定状态时无影响）、面积降序、编号升序
  list.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'available' ? -1 : 1;
    if (Math.abs(b.area - a.area) > EPS) return b.area - a.area;
    return offcutSeq(a.id) - offcutSeq(b.id);
  });

  return {
    summary: inventorySummary(store),
    count: list.length,
    offcuts: list,
    allocationGroups: allocationGroups(store),
  };
}

function offcutSeq(id) {
  const n = Number(String(id).replace(/^OC-/, ''));
  return Number.isFinite(n) ? n : 0;
}

function allocationSeq(id) {
  const n = Number(String(id).replace(/^AL-/, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 余料去重指纹：来源（类型/批次/纸张序号/轮次）+ 纸型/刀缝 + 坐标尺寸 */
function fingerprintOf(rec) {
  return [
    rec.source.type, rec.source.batchId, rec.source.sheetIndex, rec.source.round,
    rec.paperWidth, rec.paperHeight, rec.paperGrain, rec.kerf,
    rec.x, rec.y, rec.w, rec.h,
  ].join('|');
}

/* ---------------- 复用预占（原子分配） ---------------- */

/**
 * 计算成品（pw×ph，纹向要求 grain）在余料 rec 上的可行放置。
 * @returns 可行时 { rotated, placedW, placedH, residualArea }，否则 { blocked:'too-small'|'grain-blocked' }
 */
function feasiblePlacement(rec, pw, ph, grain) {
  const fitsNoRotate = pw <= rec.w + EPS && ph <= rec.h + EPS;
  const fitsRotate = ph <= rec.w + EPS && pw <= rec.h + EPS;
  const options = [];
  if (fitsNoRotate && grainAllows(grain, rec.paperGrain, false)) {
    options.push({ rotated: false, placedW: pw, placedH: ph });
  }
  if (fitsRotate && grainAllows(grain, rec.paperGrain, true)) {
    options.push({ rotated: true, placedW: ph, placedH: pw });
  }
  if (options.length === 0) {
    // 几何上任一朝向能放下，但纹向允许的朝向放不下 → 纹向受限；否则尺寸不足
    const geometricFit = fitsNoRotate || fitsRotate;
    return { blocked: geometricFit ? 'grain-blocked' : 'too-small' };
  }
  // 同一余料上两种朝向都可行时，取占用后剩余面积更小的朝向（平局不旋转优先）
  options.sort((a, b) => {
    const ra = rec.area - a.placedW * a.placedH;
    const rb = rec.area - b.placedW * b.placedH;
    if (Math.abs(ra - rb) > EPS) return ra - rb;
    return (a.rotated ? 1 : 0) - (b.rotated ? 1 : 0);
  });
  const pick = options[0];
  return {
    rotated: pick.rotated,
    placedW: round3(pick.placedW),
    placedH: round3(pick.placedH),
    residualArea: round3(rec.area - pick.placedW * pick.placedH),
  };
}

/**
 * 在给定状态上执行预占的全部校验与择优（不发布、不写盘）。
 * 缺口（shortfall）时不改动状态、不取预占号；可满足时在副本上一次性预占。
 */
function allocateInState(state, input) {
  if (!input || typeof input !== 'object') throw new Error('缺少预占请求');
  const width = positiveNumber(input.width, '成品宽度');
  const height = positiveNumber(input.height, '成品高度');
  const quantity = positiveInteger(input.quantity, '预占数量');
  const grain = normalizeProductGrain(input.grain);
  const ref = normalizeRef(input.ref);

  const candidates = [];
  let blockedTooSmall = 0;
  let blockedGrain = 0;
  let reservedCount = 0;
  for (const rec of state.offcuts.values()) {
    if (rec.status === 'reserved') { reservedCount += 1; continue; }
    const placement = feasiblePlacement(rec, width, height, grain);
    if (placement.blocked) {
      if (placement.blocked === 'grain-blocked') blockedGrain += 1;
      else blockedTooSmall += 1;
      continue;
    }
    candidates.push({ rec, ...placement });
  }

  const request = {
    width: round3(width), height: round3(height), quantity, grain, ref,
  };

  // 无法满足：原子失败——不预占任何余料，返回缺口明细
  if (candidates.length < quantity) {
    candidates.sort(compareCandidates);
    return {
      status: 'shortfall',
      allocated: false,
      request,
      summary: inventorySummary(state),
      feasibleCount: candidates.length,
      reservedCount: 0,
      shortfall: quantity - candidates.length,
      blockedBySize: blockedTooSmall,
      blockedByGrain: blockedGrain,
      unavailableReserved: reservedCount,
      candidates: candidates.map((c) => ({
        offcutId: c.rec.id,
        paperName: c.rec.paperName,
        width: c.rec.w,
        height: c.rec.h,
        paperGrain: c.rec.paperGrain,
        rotated: c.rotated,
        residualArea: c.residualArea,
      })),
    };
  }

  // 确定性择优排序后取前 quantity 条；可满足时此刻才消耗预占单号
  candidates.sort(compareCandidates);
  const chosen = candidates.slice(0, quantity);
  const allocationId = newAllocationId(state);
  const now = new Date().toISOString();
  const reserved = chosen.map((c) => {
    const rec = c.rec;
    rec.status = 'reserved';
    rec.reservation = {
      allocationId,
      product: { width: round3(width), height: round3(height), grain },
      rotated: c.rotated,
      placedW: c.placedW,
      placedH: c.placedH,
      ref,
      createdAt: now,
    };
    return {
      offcutId: rec.id,
      paperName: rec.paperName,
      width: rec.w,
      height: rec.h,
      paperGrain: rec.paperGrain,
      area: rec.area,
      rotated: c.rotated,
      placedW: c.placedW,
      placedH: c.placedH,
      residualArea: c.residualArea,
      source: rec.source,
    };
  });

  return {
    status: 'fulfilled',
    allocated: true,
    allocationId,
    request,
    feasibleCount: candidates.length,
    reservedCount: reserved.length,
    shortfall: 0,
    reserved,
  };
}

/**
 * 原子复用预占：
 *  1. 仅在“可用”余料中按旋转 / 纹向可行性收集候选；
 *  2. 候选决胜（全部确定性）：占用后剩余面积 ↑小 → 余料面积 ↑小 →
 *     余料短边 ↑小 → 余料长边 ↑小 → 不旋转优先 → 余料编号 ↑小（录入先后）；
 *  3. 在状态副本上可满足（候选数 ≥ 数量）才一次性预占并原子写盘，写盘成功
 *     后才发布；缺口不写盘、编号不前进；写盘失败库存与三个编号均不前进。
 *
 * @param {object} input { width, height, quantity, grain?, ref? }
 */
function allocateOffcuts(input) {
  const draft = cloneState(store);
  const result = allocateInState(draft, input);
  // 缺口：库存未改动、未取预占号，无需也不应写盘
  if (!result.allocated) return { ...result, summary: inventorySummary(store) };
  commitState(draft);
  return { ...result, summary: inventorySummary(store) };
}

/** 候选决胜：剩余面积小 → 余料面积小 → 短边小 → 长边小 → 不旋转 → 录入先后 */
function compareCandidates(a, b) {
  const keys = [
    () => a.residualArea - b.residualArea,
    () => a.rec.area - b.rec.area,
    () => Math.min(a.rec.w, a.rec.h) - Math.min(b.rec.w, b.rec.h),
    () => Math.max(a.rec.w, a.rec.h) - Math.max(b.rec.w, b.rec.h),
    () => (a.rotated ? 1 : 0) - (b.rotated ? 1 : 0),
    () => offcutSeq(a.rec.id) - offcutSeq(b.rec.id),
  ];
  for (const fn of keys) {
    const d = fn();
    if (Math.abs(d) > EPS) return d;
  }
  return 0;
}

/* ---------------- 释放预占 ---------------- */

/**
 * 在给定状态上完成释放的全部校验与状态修改（不发布、不写盘）。
 * 编号不存在或对应余料未预占均抛错，全部校验通过后才一次性释放。
 */
function releaseInState(state, input) {
  if (!input || typeof input !== 'object') throw new Error('缺少释放请求');
  const allocationIds = normalizeIdList(input.allocationIds, 'allocationIds');
  const offcutIds = normalizeIdList(input.offcutIds, 'offcutIds');
  if (allocationIds.length === 0 && offcutIds.length === 0) {
    throw new Error('需提供要释放的预占单号（allocationIds）或余料编号（offcutIds）');
  }

  const targets = new Map(); // id(offcut) → rec，去重
  for (const aid of allocationIds) {
    const hits = [...state.offcuts.values()].filter((r) => r.reservation
      && r.reservation.allocationId === aid);
    if (hits.length === 0) throw new Error(`预占单号不存在或已释放：${aid}`);
    for (const rec of hits) targets.set(rec.id, rec);
  }
  for (const oid of offcutIds) {
    const rec = state.offcuts.get(oid);
    if (!rec) throw new Error(`余料编号不存在：${oid}`);
    if (rec.status !== 'reserved') throw new Error(`余料 ${oid} 当前未处于预占状态，无需释放`);
    targets.set(rec.id, rec);
  }

  // 校验全部通过后原子释放
  const touchedAllocations = new Set();
  const reservations = [];
  for (const rec of targets.values()) {
    touchedAllocations.add(rec.reservation.allocationId);
    reservations.push({ offcutId: rec.id, allocationId: rec.reservation.allocationId });
    rec.status = 'available';
    rec.reservation = null;
  }
  reservations.sort((a, b) => offcutSeq(a.offcutId) - offcutSeq(b.offcutId));

  return {
    releasedCount: targets.size,
    allocationIds: [...touchedAllocations].sort(),
    offcutIds: reservations.map((r) => r.offcutId),
    reservations,
  };
}

/**
 * 释放预占：可按预占单号 allocationIds 或余料编号 offcutIds 释放。
 * 编号不存在或对应余料未预占均返回 HTTP 400（本函数抛错）。先在状态副本
 * 完成全部校验与释放，原子写盘成功后才发布；写盘失败库存不前进。
 * @returns {{ releasedCount, allocationIds, offcutIds, reservations:[...], summary }}
 */
function releaseAllocations(input) {
  const draft = cloneState(store);
  const result = releaseInState(draft, input);
  commitState(draft);
  return { ...result, summary: inventorySummary(store) };
}

function normalizeIdList(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} 含无效编号`);
    out.push(v.trim());
  }
  return [...new Set(out)];
}

module.exports = {
  _resetStore,
  _setSnapshotFile,
  initPersistence,
  SnapshotError,
  inventorySummary,
  offcutsFromLayout,
  ingestOffcuts,
  createOffcut,
  listOffcuts,
  allocateOffcuts,
  releaseAllocations,
  feasiblePlacement,
};
