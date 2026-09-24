'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const { layout } = require('../src/packer');
const {
  _resetStore,
  _setSnapshotFile,
  initPersistence,
  SnapshotError,
  ingestOffcuts,
  createOffcut,
  listOffcuts,
  allocateOffcuts,
  releaseAllocations,
} = require('../src/offcuts');

let tmpDir;
let snapshotFile;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offcuts-snap-'));
  snapshotFile = path.join(tmpDir, 'snapshot.json');
  _resetStore(snapshotFile);
});

function layoutResult() {
  return layout({
    paperW: 400, paperH: 300, paperGrain: 'along-height', kerf: 3,
    products: [{ name: '卡片', width: 120, height: 100, quantity: 2, grain: 'along-height' }],
  });
}

/* ---------------- 写盘恢复 ---------------- */

test('持久化：录入 / 登记 / 预占逐次落盘，重启后恢复库存、预占关系与三个自动编号', () => {
  // 手工录入（消耗 OC 号与自动 BATCH 号）
  const manual = createOffcut({ paperName: '手工余料', width: 300, height: 300 });
  assert.equal(manual.offcut.id, 'OC-000001');

  // 结果登记（显式批次号，登记两块余料 → OC-000002、OC-000003）
  const r1 = ingestOffcuts({ layout: layoutResult(), batchId: 'B-001' });
  assert.ok(r1.ingested >= 1);
  const totalAfterIngest = 1 + r1.ingested;

  // 预占手工录入那块：成品 250×250 只有 300×300 放得下（消耗 AL 号）
  const alloc = allocateOffcuts({ width: 250, height: 250, quantity: 1, grain: 'any', ref: 'WO-1' });
  assert.equal(alloc.status, 'fulfilled');
  assert.equal(alloc.allocationId, 'AL-000001');
  assert.deepEqual(alloc.reserved.map((r) => r.offcutId), ['OC-000001']);

  // 快照文件确实生成且为合法 JSON
  const onDisk = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  assert.equal(onDisk.app, 'sheet-layout/offcuts');
  assert.equal(onDisk.offcuts.length, listOffcuts().count);

  // 模拟服务重启：重新从同一快照恢复
  const info = initPersistence(snapshotFile);
  assert.equal(info.restored, true);
  assert.equal(info.offcutCount, totalAfterIngest);
  assert.deepEqual(info.allocationIds, ['AL-000001']);

  const list = listOffcuts();
  assert.equal(list.count, totalAfterIngest);
  assert.equal(list.summary.reserved, 1);
  const reserved = listOffcuts({ status: 'reserved' }).offcuts;
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].id, 'OC-000001');
  assert.equal(reserved[0].reservation.allocationId, 'AL-000001');
  assert.equal(reserved[0].reservation.ref, 'WO-1');
  // 登记余料的来源批次 / 纸型 / 坐标一并恢复
  const ingested = list.offcuts.find((o) => o.source.batchId === 'B-001');
  assert.ok(ingested, '来源批次 B-001 的余料应恢复');
  assert.equal(ingested.paperWidth, 400);

  // 编号不回退、不碰撞：恢复后新增记录沿用原序号继续
  const again = createOffcut({ width: 10, height: 10 });
  assert.equal(again.offcut.id, `OC-${String(totalAfterIngest + 1).padStart(6, '0')}`);

  // 释放后再“重启”：预占关系的解除同样持久化
  releaseAllocations({ allocationIds: ['AL-000001'] });
  initPersistence(snapshotFile);
  assert.equal(listOffcuts({ status: 'reserved' }).count, 0);
  const nextAlloc = allocateOffcuts({ width: 250, height: 250, quantity: 1 });
  assert.equal(nextAlloc.status, 'fulfilled');
  assert.ok(nextAlloc.allocationId > 'AL-000001'); // 预占号单调不回退
});

test('持久化：自动批次号在恢复后继续单调递增', () => {
  ingestOffcuts({ layout: layoutResult() }); // BATCH-000001
  ingestOffcuts({ layout: layoutResult(), batchId: 'EXPLICIT-1' }); // 不消耗自动号
  initPersistence(snapshotFile);
  const out = ingestOffcuts({
    layout: layout({
      paperW: 200, paperH: 150, kerf: 2,
      products: [{ width: 60, height: 60, quantity: 1 }],
    }),
  });
  assert.equal(out.batchId, 'BATCH-000002');
});

test('持久化：恢复后同批次重复登记仍按来源指纹去重（重试不产生跳过/错位）', () => {
  const r = layoutResult();
  const first = ingestOffcuts({ layout: r, batchId: 'DUP' });
  assert.ok(first.ingested >= 1);

  // “重启”后以同一来源批次重复提交同样结果
  initPersistence(snapshotFile);
  const dup = ingestOffcuts({ layout: r, batchId: 'DUP' });
  assert.equal(dup.ingested, 0);
  assert.equal(dup.skipped, first.ingested);
  assert.equal(listOffcuts().count, first.ingested);

  // 不同批次仍可登记
  const other = ingestOffcuts({ layout: r, batchId: 'DUP-2' });
  assert.equal(other.ingested, first.ingested);
});

test('持久化：快照文件不存在时从空库启动，首次变更后生成快照（目录自动创建）', () => {
  const missing = path.join(tmpDir, 'nested', 'not-there.json');
  _resetStore(missing);
  const info = initPersistence(missing);
  assert.equal(info.restored, false);
  assert.equal(info.offcutCount, 0);
  assert.equal(listOffcuts().count, 0);
  const { offcut } = createOffcut({ width: 10, height: 10 });
  assert.equal(offcut.id, 'OC-000001');
  assert.ok(fs.existsSync(missing), '首次写入应自动创建目录并生成快照文件');
});

/* ---------------- 写盘失败：库存与三个编号均不前进 ---------------- */

test('写盘失败：手工录入抛 SnapshotError，库存与余料/批次序号不前进', () => {
  // 目标父路径是普通文件而非目录 → mkdir / rename 必然失败
  const blocker = path.join(tmpDir, 'a-file');
  fs.writeFileSync(blocker, 'x');
  const bad = path.join(blocker, 'snapshot.json');
  _resetStore(bad);
  assert.throws(() => createOffcut({ width: 10, height: 10 }), (err) => {
    assert.ok(err instanceof SnapshotError);
    assert.equal(err.statusCode, 500);
    return true;
  });
  // 库存未发布
  assert.equal(listOffcuts().count, 0);

  // 修好存储后重试：编号从头开始，没有被失败请求消耗
  _resetStore(snapshotFile);
  initPersistence(snapshotFile);
  const ok = createOffcut({ width: 10, height: 10 });
  assert.equal(ok.offcut.id, 'OC-000001');
  assert.equal(ok.offcut.source.batchId, 'BATCH-000001');
});

test('写盘失败：结果登记整批不写入，余料/批次序号不前进', () => {
  const blocker = path.join(tmpDir, 'a-file-2');
  fs.writeFileSync(blocker, 'x');
  _resetStore(path.join(blocker, 'snapshot.json'));
  assert.throws(() => ingestOffcuts({ layout: layoutResult() }), SnapshotError);
  assert.equal(listOffcuts().count, 0);

  _resetStore(snapshotFile);
  initPersistence(snapshotFile);
  const out = ingestOffcuts({ layout: layoutResult() });
  assert.deepEqual(out.offcutIds[0], 'OC-000001');
  assert.equal(out.batchId, 'BATCH-000001');
});

test('写盘失败：预占不发布，已占库存与预占序号保持原状', () => {
  // 先在正常快照中准备一块已预占余料与另一块可用余料
  createOffcut({ width: 300, height: 300 }); // OC-000001
  createOffcut({ width: 200, height: 200 }); // OC-000002，仍可用
  const first = allocateOffcuts({ width: 250, height: 250, quantity: 1 });
  assert.equal(first.allocationId, 'AL-000001');
  assert.deepEqual(first.reserved.map((r) => r.offcutId), ['OC-000001']);

  // 模拟写盘目标变为不可写（保留当前库存，不重置）：
  // 可满足请求在副本中取了 AL-000002，但写盘失败 → 预占不发布
  const blocker = path.join(tmpDir, 'a-file-3');
  fs.writeFileSync(blocker, 'x');
  _setSnapshotFile(path.join(blocker, 'snapshot.json'));
  assert.throws(
    () => allocateOffcuts({ width: 100, height: 100, quantity: 1 }),
    SnapshotError
  );
  // 发布也被阻止：内存里 OC-000002 仍可用，OC-000001 仍预占
  assert.equal(listOffcuts({ status: 'available' }).count, 1);
  assert.equal(listOffcuts({ status: 'reserved' }).count, 1);

  // 恢复正常存储并从快照重新加载：仍是最初已提交的 AL-000001 占用
  _setSnapshotFile(snapshotFile);
  initPersistence(snapshotFile);
  const reserved = listOffcuts({ status: 'reserved' }).offcuts;
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].id, 'OC-000001');
  assert.equal(reserved[0].reservation.allocationId, 'AL-000001');
  // 失败的预占未消耗预占号：再次预占用掉的是 AL-000002
  const retry = allocateOffcuts({ width: 100, height: 100, quantity: 1 });
  assert.equal(retry.status, 'fulfilled');
  assert.equal(retry.allocationId, 'AL-000002');
  assert.deepEqual(retry.reserved.map((r) => r.offcutId), ['OC-000002']);
});

test('写盘失败：释放不发布，预占关系保持原状', () => {
  createOffcut({ width: 300, height: 300 });
  const alloc = allocateOffcuts({ width: 100, height: 100, quantity: 1 });
  assert.equal(alloc.allocationId, 'AL-000001');

  // 写盘目标变为不可写（保留当前库存）：释放的校验通过但提交失败
  const blocker = path.join(tmpDir, 'a-file-4');
  fs.writeFileSync(blocker, 'x');
  _setSnapshotFile(path.join(blocker, 'snapshot.json'));
  assert.throws(
    () => releaseAllocations({ allocationIds: ['AL-000001'] }),
    SnapshotError
  );

  // 内存发布也被阻止，恢复正常快照后预占关系原样存在
  _setSnapshotFile(snapshotFile);
  initPersistence(snapshotFile);
  const reserved = listOffcuts({ status: 'reserved' }).offcuts;
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].reservation.allocationId, 'AL-000001');
});

/* ---------------- 快照损坏：明确拒绝启动 ---------------- */

test('快照损坏：JSON 非法 / 结构或编号不一致时拒绝启动，不当作空库', () => {
  const rejectStart = (content, msgHint) => {
    fs.writeFileSync(snapshotFile, content);
    assert.throws(() => initPersistence(snapshotFile), (err) => {
      assert.match(err.message, /库存快照损坏，拒绝启动/, err.message);
      assert.ok(err.message.includes(msgHint), `错误信息应指出 ${msgHint}：${err.message}`);
      return true;
    });
  };

  rejectStart('{ not json', 'JSON');
  rejectStart(JSON.stringify({ app: 'sheet-layout/offcuts', version: 1 }), 'offcuts');
  rejectStart(JSON.stringify({
    app: 'sheet-layout/offcuts', version: 999,
    seq: 0, allocSeq: 0, batchSeq: 0, offcuts: [],
  }), '版本');
  rejectStart(JSON.stringify({
    app: 'wrong-app', version: 1,
    seq: 0, allocSeq: 0, batchSeq: 0, offcuts: [],
  }), 'app');

  // 编号不一致：seq 小于库存最大编号（典型的截断 / 旧文件损坏）
  const validRecord = {
    id: 'OC-000002',
    paperName: null, paperWidth: 300, paperHeight: 300, paperGrain: 'along-width',
    kerf: 0, x: 0, y: 0, w: 300, h: 300, area: 90000,
    status: 'available', reservation: null,
    source: {
      type: 'manual', batchId: 'BATCH-000001', sheetIndex: null, round: null,
      paperId: null, orderNo: null, ingestedAt: '2026-09-23T00:00:00.000Z',
    },
  };
  rejectStart(JSON.stringify({
    app: 'sheet-layout/offcuts', version: 1,
    seq: 1, allocSeq: 0, batchSeq: 1, offcuts: [validRecord],
  }), 'seq');

  // 预占状态缺少 reservation
  const dangling = {
    ...validRecord,
    id: 'OC-000001',
    status: 'reserved',
    reservation: null,
  };
  rejectStart(JSON.stringify({
    app: 'sheet-layout/offcuts', version: 1,
    seq: 1, allocSeq: 1, batchSeq: 1, offcuts: [dangling],
  }), '预占');

  // 损坏快照拒绝启动后，内存不被污染：修好快照可正常恢复
  const good = {
    app: 'sheet-layout/offcuts', version: 1,
    seq: 1, allocSeq: 0, batchSeq: 1,
    offcuts: [{ ...validRecord, id: 'OC-000001' }],
  };
  fs.writeFileSync(snapshotFile, JSON.stringify(good));
  const info = initPersistence(snapshotFile);
  assert.equal(info.restored, true);
  assert.equal(info.offcutCount, 1);
  assert.equal(listOffcuts().offcuts[0].id, 'OC-000001');
});

/* ---------------- 快照恢复：预占一致性核对 ---------------- */

// 100×80 余料（沿宽纹纸张）上 90×50 沿宽纹向成品的合法预占记录
const RESERVED_REC = {
  id: 'OC-000001',
  paperName: null, paperWidth: 100, paperHeight: 80, paperGrain: 'along-width',
  kerf: 0, x: 0, y: 0, w: 100, h: 80, area: 8000,
  status: 'reserved',
  reservation: {
    allocationId: 'AL-000001',
    product: { width: 90, height: 50, grain: 'along-width' },
    rotated: false, placedW: 90, placedH: 50,
    ref: null, createdAt: '2026-09-24T00:00:00.000Z',
  },
  source: {
    type: 'manual', batchId: 'BATCH-000001', sheetIndex: null, round: null,
    paperId: null, orderNo: null, ingestedAt: '2026-09-24T00:00:00.000Z',
  },
};

function snapOf(offcuts, seq = 1, allocSeq = 1, batchSeq = 1) {
  return JSON.stringify({
    app: 'sheet-layout/offcuts', version: 1, seq, allocSeq, batchSeq, offcuts,
  });
}

// 写入快照并断言拒绝启动：错误须指出余料编号与问题要点，且不发布半恢复库存
function rejectRestore(content, ocId, msgHint) {
  fs.writeFileSync(snapshotFile, content);
  assert.throws(() => initPersistence(snapshotFile), (err) => {
    assert.match(err.message, /库存快照损坏，拒绝启动/, err.message);
    assert.ok(err.message.includes(ocId), `错误信息应指出余料编号 ${ocId}：${err.message}`);
    assert.ok(err.message.includes(msgHint), `错误信息应指出 ${msgHint}：${err.message}`);
    return true;
  });
  assert.equal(listOffcuts().count, 0, '不一致的快照不得发布半恢复库存');
}

test('快照恢复：篡改预占朝向与放置宽高导致越界时，指出余料编号并拒绝启动', () => {
  // 100×80 余料上 90×50 沿宽纹向成品：rotated 改为 true、放置宽高改为 50×90，
  // 放置高 90 超出余料高 80 —— 恢复必须拒绝而非恢复出越界预占
  const rec = structuredClone(RESERVED_REC);
  rec.reservation.rotated = true;
  rec.reservation.placedW = 50;
  rec.reservation.placedH = 90;
  rejectRestore(snapOf([rec]), 'OC-000001', '超出余料范围');
});

test('快照恢复：放置宽高与成品尺寸及旋转状态不一致时拒绝启动', () => {
  // 未旋转时放置宽必须等于成品宽 90（80×50 虽在余料界内仍不一致）
  const rec = structuredClone(RESERVED_REC);
  rec.reservation.placedW = 80;
  rejectRestore(snapOf([rec]), 'OC-000001', '不一致');

  // 未旋转却按旋转后的宽高登记（50×90）
  const swapped = structuredClone(RESERVED_REC);
  swapped.reservation.placedW = 50;
  swapped.reservation.placedH = 90;
  rejectRestore(snapOf([swapped]), 'OC-000001', '不一致');
});

test('快照恢复：预占放置宽高必须为正', () => {
  const rec = structuredClone(RESERVED_REC);
  rec.reservation.placedW = 0;
  rec.reservation.placedH = 50;
  rejectRestore(snapOf([rec]), 'OC-000001', '必须为正');
});

test('快照恢复：预占朝向违反纸张与成品纹向平行规则时拒绝启动', () => {
  // 50×40 沿宽纹向成品在沿宽纹纸张上仅允许不旋转；篡改为旋转（40×50 仍在界内）
  const rec = structuredClone(RESERVED_REC);
  rec.reservation.product = { width: 50, height: 40, grain: 'along-width' };
  rec.reservation.rotated = true;
  rec.reservation.placedW = 40;
  rec.reservation.placedH = 50;
  rejectRestore(snapOf([rec]), 'OC-000001', '纹向');
});

test('快照恢复：任一余料预占不一致即整体拒绝，不发布半恢复库存', () => {
  const goodAvailable = {
    id: 'OC-000001',
    paperName: null, paperWidth: 300, paperHeight: 300, paperGrain: 'along-width',
    kerf: 0, x: 0, y: 0, w: 300, h: 300, area: 90000,
    status: 'available', reservation: null,
    source: {
      type: 'manual', batchId: 'BATCH-000001', sheetIndex: null, round: null,
      paperId: null, orderNo: null, ingestedAt: '2026-09-24T00:00:00.000Z',
    },
  };
  const badReserved = structuredClone(RESERVED_REC);
  badReserved.id = 'OC-000002';
  badReserved.source.batchId = 'BATCH-000002';
  badReserved.reservation.placedH = 90.5; // 与成品高 50 不一致
  rejectRestore(snapOf([goodAvailable, badReserved], 2, 1, 2), 'OC-000002', '不一致');
});

test('快照恢复：合法预占（含旋转放置）照常恢复库存、预占关系与编号', () => {
  // 旋转放置的合法预占：50×90 成品（纹向不限）旋转 90° → 放置 90×50，在 100×80 界内
  const rotatedRec = structuredClone(RESERVED_REC);
  rotatedRec.reservation.product = { width: 50, height: 90, grain: 'any' };
  rotatedRec.reservation.rotated = true;
  rotatedRec.reservation.placedW = 90;
  rotatedRec.reservation.placedH = 50;
  const availableRec = {
    id: 'OC-000002',
    paperName: '备用', paperWidth: 200, paperHeight: 100, paperGrain: 'along-height',
    kerf: 0, x: 0, y: 0, w: 200, h: 100, area: 20000,
    status: 'available', reservation: null,
    source: {
      type: 'manual', batchId: 'BATCH-000002', sheetIndex: null, round: null,
      paperId: null, orderNo: null, ingestedAt: '2026-09-24T00:00:00.000Z',
    },
  };
  fs.writeFileSync(snapshotFile, snapOf([rotatedRec, availableRec], 2, 1, 2));

  const info = initPersistence(snapshotFile);
  assert.equal(info.restored, true);
  assert.equal(info.offcutCount, 2);
  assert.deepEqual(info.allocationIds, ['AL-000001']);
  const reserved = listOffcuts({ status: 'reserved' }).offcuts;
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].id, 'OC-000001');
  assert.equal(reserved[0].reservation.rotated, true);
  assert.equal(reserved[0].reservation.placedW, 90);
  assert.equal(reserved[0].reservation.placedH, 50);
  assert.equal(listOffcuts({ status: 'available' }).count, 1);

  // 编号照常继续，不回退、不碰撞
  const again = createOffcut({ width: 10, height: 10 });
  assert.equal(again.offcut.id, 'OC-000003');
});

test('未配置快照文件时退化为纯内存模式（兼容无持久化部署）', () => {
  _resetStore(null);
  assert.equal(initPersistence(null), null);
  const { offcut } = createOffcut({ width: 10, height: 10 });
  assert.equal(offcut.id, 'OC-000001');
  assert.equal(listOffcuts().count, 1);
});

/* ---------------- 尺寸精度：落盘自洽、重启可恢复 ---------------- */

test('尺寸精度：100.0004 类小数尺寸按 0.001mm 落盘，快照自洽且重启可恢复', () => {
  const { offcut } = createOffcut({ width: 100.0004, height: 100.0004 });
  // 宽高与面积是同一组舍入值：面积 = 舍入后宽×高（不再出现 100×100 配 10000.08）
  assert.equal(offcut.w, 100);
  assert.equal(offcut.h, 100);
  assert.equal(offcut.paperWidth, 100);
  assert.equal(offcut.paperHeight, 100);
  assert.equal(offcut.area, 10000);

  // 写盘内容逐字段自洽
  const onDisk = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  assert.equal(onDisk.offcuts[0].w, 100);
  assert.equal(onDisk.offcuts[0].area, 10000);

  // 重启恢复不再被拒绝；查询到的尺寸与落盘值一致
  const info = initPersistence(snapshotFile);
  assert.equal(info.restored, true);
  const rec = listOffcuts().offcuts[0];
  assert.equal(rec.w, 100);
  assert.equal(rec.area, 10000);

  // 预占使用同一组落盘尺寸：100×100 成品恰好放下
  const alloc = allocateOffcuts({ width: 100, height: 100, quantity: 1 });
  assert.equal(alloc.status, 'fulfilled');
  initPersistence(snapshotFile);
  assert.equal(listOffcuts({ status: 'reserved' }).count, 1);
});

test('尺寸精度：有效三位小数尺寸写入后重启恢复，查询与预占使用同一组尺寸', () => {
  createOffcut({ width: 100.125, height: 50.5 });
  initPersistence(snapshotFile);
  const rec = listOffcuts().offcuts[0];
  assert.equal(rec.w, 100.125);
  assert.equal(rec.h, 50.5);
  assert.equal(rec.area, Math.round(100.125 * 50.5 * 1000) / 1000);
  // 最小尺寸筛选与预占可行性都按落盘尺寸判定（不多不少）
  assert.equal(listOffcuts({ minW: 100.125, minH: 50.5 }).count, 1);
  assert.equal(listOffcuts({ minW: 100.126, minH: 50.5 }).count, 0);
  const alloc = allocateOffcuts({ width: 100.125, height: 50.5, quantity: 1 });
  assert.equal(alloc.status, 'fulfilled');
  const gap = allocateOffcuts({ width: 100.126, height: 50.5, quantity: 1 });
  assert.equal(gap.status, 'shortfall');
});

test('尺寸精度：结果登记的小数余料同样自洽落盘、重启可恢复', () => {
  const sheet = {
    paper: { width: 100.0004, height: 100.0004, kerf: 0, grain: 'along-width' },
    frees: [{ x: 0, y: 0, w: 100.0004, h: 100.0004 }],
  };
  const out = ingestOffcuts({ layout: sheet, batchId: 'DEC-1' });
  assert.equal(out.ingested, 1);
  const rec = listOffcuts().offcuts[0];
  assert.equal(rec.w, 100);
  assert.equal(rec.paperWidth, 100);
  assert.equal(rec.area, 10000);
  // 重启恢复不抛错，库存原样回来
  const info = initPersistence(snapshotFile);
  assert.equal(info.restored, true);
  assert.equal(listOffcuts().count, 1);
});

test('尺寸精度：舍入后为零的极小尺寸明确报错，不写盘、编号不前进', () => {
  assert.throws(() => createOffcut({ width: 0.0004, height: 5 }), /舍入后为 0/);
  assert.throws(() => createOffcut({ width: 5, height: 0.0004 }), /舍入后为 0/);
  assert.equal(listOffcuts().count, 0);
  assert.ok(!fs.existsSync(snapshotFile), '校验失败不得生成快照');

  // 余料号与批次号均未消耗：后续有效录入仍取 OC-000001 / BATCH-000001
  const ok = createOffcut({ width: 10, height: 10 });
  assert.equal(ok.offcut.id, 'OC-000001');
  assert.equal(ok.offcut.source.batchId, 'BATCH-000001');
});

test('尺寸精度：批量登记含舍入后为零的余料时整批不生效，余料/批次编号不前进', () => {
  const goodSheet = {
    paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
    frees: [{ x: 0, y: 0, w: 50, h: 40 }],
  };
  const tinySheet = {
    paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
    frees: [{ x: 0, y: 50, w: 0.0004, h: 40 }], // 宽按 0.001mm 舍入后为 0
  };
  assert.throws(
    () => ingestOffcuts({ layout: { sheets: [goodSheet, tinySheet] } }),
    /舍入后为 0/
  );
  assert.equal(listOffcuts().count, 0);
  assert.ok(!fs.existsSync(snapshotFile), '整批不生效，不得写盘');

  // 修正后重试：无跳过记录，余料号 / 批次号从 1 开始
  const retry = ingestOffcuts({ layout: { sheets: [goodSheet] } });
  assert.equal(retry.ingested, 1);
  assert.equal(retry.skipped, 0);
  assert.deepEqual(retry.offcutIds, ['OC-000001']);
  assert.equal(retry.batchId, 'BATCH-000001');
});

test('尺寸精度：舍入后越出纸面或坐标为负的余料明确报错（与启动恢复同一核对）', () => {
  // 原始值看似界内（0.0006+99.9996 = 100.0002 ≤ 纸宽 100.0002），
  // 但落盘舍入后 0.001+100 = 100.001 越出纸面 100 —— 必须在录入时拒绝，
  // 而不是写出一个重启后无法恢复的快照
  const sneaky = {
    paper: { width: 100.0002, height: 50, kerf: 0, grain: 'along-width' },
    frees: [{ x: 0.0006, y: 0, w: 99.9996, h: 40 }],
  };
  assert.throws(() => ingestOffcuts({ layout: sneaky }), /超出纸面/);

  const negative = {
    paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
    frees: [{ x: -0.6, y: 0, w: 10, h: 10 }],
  };
  assert.throws(() => ingestOffcuts({ layout: negative }), /坐标不能为负/);

  assert.equal(listOffcuts().count, 0);
  assert.ok(!fs.existsSync(snapshotFile));
});
