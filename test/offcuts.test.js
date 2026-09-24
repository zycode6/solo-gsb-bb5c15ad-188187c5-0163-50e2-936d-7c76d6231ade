'use strict';

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const { layout, layoutBatch } = require('../src/packer');
const { layoutCostBatch } = require('../src/cost');
const offcuts = require('../src/offcuts');

const {
  _resetStore,
  ingestOffcuts,
  createOffcut,
  listOffcuts,
  allocateOffcuts,
  releaseAllocations,
  feasiblePlacement,
} = offcuts;

beforeEach(() => _resetStore());

/* ---------------- 录入 / 标准化 ---------------- */

test('单张结果登记：layout.frees 标准化为可追踪余料（纸型/纹向/刀缝/坐标/尺寸/批次）', () => {
  const r = layout({
    paperW: 400, paperH: 300, paperGrain: 'along-height', kerf: 3,
    products: [{ name: '卡片', width: 120, height: 100, quantity: 2, grain: 'along-height' }],
  });
  assert.ok(r.frees.length > 0, '该排样应产生余料');

  const out = ingestOffcuts({ layout: r, batchId: 'B-001' });
  assert.equal(out.ingested, r.frees.length);
  assert.equal(out.skipped, 0);
  assert.equal(out.batchId, 'B-001');

  const list = listOffcuts().offcuts;
  assert.equal(list.length, r.frees.length);
  const byId = new Map(list.map((o) => [o.id, o]));
  for (const f of r.frees) {
    // 每个自由矩形都应登记，且字段完整保留
    const hit = list.find((o) =>
      o.x === f.x && o.y === f.y && o.w === f.w && o.h === f.h);
    assert.ok(hit, `自由矩形 (${f.x},${f.y},${f.w},${f.h}) 应被登记`);
    assert.equal(hit.paperWidth, 400);
    assert.equal(hit.paperHeight, 300);
    assert.equal(hit.paperGrain, 'along-height');
    assert.equal(hit.kerf, 3);
    assert.equal(hit.area, f.area);
    assert.equal(hit.status, 'available');
    assert.equal(hit.source.type, 'single');
    assert.equal(hit.source.batchId, 'B-001');
    assert.equal(hit.source.sheetIndex, 1);
    assert.ok(hit.source.ingestedAt);
    assert.ok(byId.has(hit.id));
  }
});

test('批量结果登记：逐张纸张、轮次与订单号随余料透传', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 200, kerf: 2, maxSheets: 3,
    products: [
      { name: 'A', width: 80, height: 60, quantity: 20, orderNo: 'SO-1' },
    ],
    isolateOrders: true,
  });
  assert.ok(r.sheets.length >= 1);
  const out = ingestOffcuts({ layout: r });
  assert.equal(out.shape, 'batch');
  const list = listOffcuts().offcuts;
  const sheets = new Set(list.map((o) => o.source.sheetIndex));
  assert.equal(sheets.size, r.sheets.length);
  assert.ok(list.every((o) => o.source.type === 'batch'));
  assert.ok(list.every((o) => o.source.orderNo === 'SO-1'));
  // 自动生成批次号
  assert.ok(list.every((o) => typeof o.source.batchId === 'string' && o.source.batchId.length > 0));
});

test('多纸型成本结果登记：layout 解包、纸型名称与轮次保留', () => {
  const r = layoutCostBatch({
    kerf: 2,
    papers: [
      { name: '大纸', width: 500, height: 400, grain: 'along-width', price: 2, stock: 3 },
      { name: '小纸', width: 300, height: 200, grain: 'along-height', price: 0.5, stock: 10 },
    ],
    products: [{ name: '盒', width: 100, height: 80, quantity: 6 }],
  });
  assert.ok(r.sheets.length >= 1);
  const out = ingestOffcuts({ layout: r });
  assert.equal(out.shape, 'cost');
  const list = listOffcuts().offcuts;
  for (const sh of r.sheets) {
    for (const f of sh.layout.frees) {
      const hit = list.find((o) =>
        o.source.round === sh.round && o.w === f.w && o.h === f.h);
      assert.ok(hit, `第 ${sh.round} 张余料应登记`);
      assert.equal(hit.paperName, sh.paperName);
      assert.equal(hit.source.paperId, sh.paperId);
      assert.equal(hit.paperGrain, sh.paperGrain);
    }
  }
});

test('方案比选结果登记：登记中选候选（best 为 null 时登记首个候选）', () => {
  // 能排进件的输入
  const r = require('../src/packer').layoutCompare({
    paperW: 400, paperH: 300, kerf: 3,
    objective: 'more-pieces',
    products: [{ width: 120, height: 90, quantity: 3 }],
  });
  const out = ingestOffcuts({ layout: r });
  assert.equal(out.shape, 'compare');
  assert.equal(out.ingested, r.best.layout.frees.length);

  // 全部排不进：best 为 null 不报错，登记首个候选
  _resetStore();
  const empty = require('../src/packer').layoutCompare({
    paperW: 50, paperH: 50, kerf: 1,
    products: [{ width: 200, height: 200, quantity: 1 }],
  });
  assert.equal(empty.best, null);
  const out2 = ingestOffcuts({ layout: empty });
  assert.ok(out2.ingested >= 0);
});

test('手工录入余料并保留来源批次/纸型/纹向/刀缝', () => {
  const { offcut } = createOffcut({
    paperName: 'A3余料', width: 297, height: 200,
    paperGrain: 'along-height', kerf: 2, batchId: 'MAN-1', orderNo: 'SO-9',
  });
  assert.match(offcut.id, /^OC-\d{6}$/);
  assert.equal(offcut.paperName, 'A3余料');
  assert.equal(offcut.paperGrain, 'along-height');
  assert.equal(offcut.kerf, 2);
  assert.equal(offcut.x, 0);
  assert.equal(offcut.y, 0);
  assert.equal(offcut.area, 297 * 200);
  assert.equal(offcut.status, 'available');
  assert.equal(offcut.source.type, 'manual');
  assert.equal(offcut.source.batchId, 'MAN-1');
  assert.equal(offcut.source.orderNo, 'SO-9');

  // 缺省刀缝为 0、纹向缺省沿宽、批次自动生成
  const { offcut: o2 } = createOffcut({ width: 100, height: 80 });
  assert.equal(o2.kerf, 0);
  assert.equal(o2.paperGrain, 'along-width');
  assert.ok(o2.source.batchId);
});

test('校验：手工录入与结果非法输入返回 400 信息', () => {
  assert.throws(() => createOffcut({ width: 0, height: 100 }), /正数/);
  assert.throws(() => createOffcut({ width: 100, height: -1 }), /正数/);
  assert.throws(() => createOffcut({ width: 100, height: 100, kerf: -1 }), /非负/);
  assert.throws(() => createOffcut({ width: 100, height: 100, paperGrain: 'weird' }), /纹向/);
  assert.throws(() => ingestOffcuts({}), /无法识别|缺少/);
  assert.throws(() => ingestOffcuts({ layout: { frees: [] } }), /无法识别/);
});

test('落盘精度：小数尺寸按 0.001mm 舍入落盘，宽高与面积自洽', () => {
  // 100.0004 舍入为 100：宽、高、纸面与面积（100×100=10000）彼此一致
  const { offcut } = createOffcut({ width: 100.0004, height: 100.0004 });
  assert.equal(offcut.w, 100);
  assert.equal(offcut.h, 100);
  assert.equal(offcut.paperWidth, 100);
  assert.equal(offcut.paperHeight, 100);
  assert.equal(offcut.area, 10000);

  // 三位小数尺寸精确落盘，面积由落盘宽高计算
  const { offcut: dec } = createOffcut({ width: 100.5, height: 80.25, kerf: 0.0004 });
  assert.equal(dec.w, 100.5);
  assert.equal(dec.h, 80.25);
  assert.equal(dec.kerf, 0);
  assert.equal(dec.area, 8065.125);

  // 查询与预占使用同一组落盘尺寸
  assert.equal(listOffcuts({ minW: 100.5, minH: 80.25 }).count, 1);
  assert.equal(listOffcuts({ minW: 100.6, minH: 80.25 }).count, 0);
  const alloc = allocateOffcuts({ width: 100.5, height: 80.25, quantity: 1 });
  assert.equal(alloc.status, 'fulfilled');
  assert.equal(alloc.reserved[0].offcutId, dec.id);
  assert.equal(alloc.reserved[0].residualArea, 0);
});

test('落盘精度：正数尺寸舍入后为零明确报错，编号不前进', () => {
  assert.throws(() => createOffcut({ width: 0.0004, height: 10 }), /舍入后为零/);
  assert.throws(() => createOffcut({ width: 10, height: 0.0004 }), /舍入后为零/);
  // 结果登记路径同样拒绝（含纸张尺寸舍入后为零）
  assert.throws(
    () => ingestOffcuts({
      layout: { paper: { width: 100, height: 100 }, frees: [{ x: 0, y: 0, w: 0.0004, h: 50 }] },
    }),
    /舍入后为零/
  );
  assert.throws(
    () => ingestOffcuts({ layout: { paper: { width: 0.0004, height: 100 }, frees: [] } }),
    /舍入后为零/
  );
  // 全部失败不消耗余料 / 批次序号
  const { offcut } = createOffcut({ width: 10, height: 10 });
  assert.equal(offcut.id, 'OC-000001');
  assert.equal(offcut.source.batchId, 'BATCH-000001');
});

/* ---------------- 查询 ---------------- */

test('查询：状态 / 最小尺寸 / 纹向 / 关键字筛选与汇总', () => {
  createOffcut({ paperName: '大块', width: 300, height: 200, grain: 'along-width', batchId: 'Q' });
  createOffcut({ paperName: '窄条', width: 50, height: 400, grain: 'along-height', batchId: 'Q' });
  createOffcut({ paperName: '小块', width: 80, height: 60, grain: 'along-width', batchId: 'Q' });

  const all = listOffcuts();
  assert.equal(all.count, 3);
  assert.equal(all.summary.available, 3);
  assert.equal(all.summary.reserved, 0);

  // 最小尺寸（允许旋转）
  assert.equal(listOffcuts({ minW: 100, minH: 100 }).count, 1);
  assert.equal(listOffcuts({ minW: 400, minH: 40 }).count, 1); // 窄条旋转
  // 纹向
  assert.equal(listOffcuts({ grain: 'along-height' }).count, 1);
  // 关键字
  assert.equal(listOffcuts({ q: '块' }).count, 2);
  assert.equal(listOffcuts({ q: 'Q' }).count, 3);
  // 状态非法
  assert.throws(() => listOffcuts({ status: 'nope' }), /状态/);
});

/* ---------------- 旋转 / 纹向可行性 ---------------- */

test('feasiblePlacement：旋转可行与纹向受阻判定', () => {
  const { offcut: wide } = createOffcut({ width: 300, height: 100, paperGrain: 'along-width' });

  // 不旋转放下（200×80）
  let f = feasiblePlacement(wide, 200, 80, 'any');
  assert.equal(f.blocked, undefined);
  assert.equal(f.rotated, false);
  assert.equal(f.residualArea, wide.area - 200 * 80);

  // 必须旋转（80×200：不旋转 200>100 放不了，旋转后 80×200 放进 300×100？
  // 旋转放置尺寸为 200(=ph?) 实际：rotated 时 placedW=ph=200, placedH=pw=80）
  f = feasiblePlacement(wide, 80, 200, 'any');
  assert.equal(f.rotated, true);

  // 尺寸不足
  f = feasiblePlacement(wide, 500, 500, 'any');
  assert.equal(f.blocked, 'too-small');

  // 纹向：纸沿宽；成品要求沿自身宽 → 只能不旋转；几何上仅旋转能放下 → 纹向受阻
  const { offcut: narrow } = createOffcut({ width: 100, height: 300, paperGrain: 'along-width' });
  f = feasiblePlacement(narrow, 200, 80, 'along-width');
  assert.equal(f.blocked, 'grain-blocked');

  // 纸沿宽，成品沿自身宽且不旋转放得下 → 可行
  f = feasiblePlacement(narrow, 80, 200, 'along-width');
  assert.equal(f.rotated, false);
  assert.equal(f.blocked, undefined);
});

/* ---------------- 原子预占 ---------------- */

test('预占：最小剩余面积确定性择优，足量时原子占用', () => {
  // 三块都能放下 100×100，剩余面积不同
  createOffcut({ paperName: '大块', width: 300, height: 300 }); // 剩余 80000
  createOffcut({ paperName: '恰', width: 101, height: 101 }); // 剩余 ~201
  createOffcut({ paperName: '中块', width: 150, height: 150 }); // 剩余 12500
  const out = allocateOffcuts({ width: 100, height: 100, quantity: 2, grain: 'any' });
  assert.equal(out.status, 'fulfilled');
  assert.equal(out.allocated, true);
  assert.equal(out.reservedCount, 2);
  // 选中最小剩余面积的两块：恰 + 中块
  const names = out.reserved.map((r) => r.paperName).sort();
  assert.deepEqual(names, ['中块', '恰']);
  // 确定性：两次相同库存选择一致
  _resetStore();
  createOffcut({ paperName: '大块', width: 300, height: 300 });
  createOffcut({ paperName: '恰', width: 101, height: 101 });
  createOffcut({ paperName: '中块', width: 150, height: 150 });
  const out2 = allocateOffcuts({ width: 100, height: 100, quantity: 2 });
  assert.deepEqual(out2.reserved.map((r) => r.paperName).sort(), names);

  // 已预占记录状态翻转、带预占单信息
  const list = listOffcuts({ status: 'reserved' });
  assert.equal(list.count, 2);
  assert.ok(list.offcuts.every((o) => o.reservation.allocationId === out2.allocationId));
  assert.equal(listOffcuts({ status: 'available' }).count, 1);
  assert.equal(out2.summary.reserved, 2);
  assert.equal(out2.summary.available, 1);
});

test('预占：平局按余料面积→短边→长边→不旋转→录入先后决胜', () => {
  // 两块等剩余面积（成品 100×100，余料均 200×100 = 20000，剩余 10000）
  const a = createOffcut({ paperName: '先录入', width: 200, height: 100 }).offcut;
  const b = createOffcut({ paperName: '后录入', width: 200, height: 100 }).offcut;
  const out = allocateOffcuts({ width: 100, height: 100, quantity: 1 });
  assert.equal(out.reserved[0].offcutId, a.id); // 录入先后决胜
});

test('预占缺口：数量不足时不扣减任何已占用记录并返回缺口明细', () => {
  createOffcut({ paperName: '仅一块可行', width: 300, height: 100 });
  createOffcut({ paperName: '太小', width: 30, height: 30 });

  const before = listOffcuts();
  const out = allocateOffcuts({ width: 200, height: 80, quantity: 3, grain: 'any' });
  assert.equal(out.status, 'shortfall');
  assert.equal(out.allocated, false);
  assert.equal(out.feasibleCount, 1);
  assert.equal(out.shortfall, 2);
  assert.equal(out.blockedBySize, 1);
  assert.equal(out.blockedByGrain, 0);
  assert.equal(out.reservedCount, 0);
  assert.equal(out.candidates.length, 1); // 缺口时仍返回可行候选明细
  assert.equal(out.candidates[0].paperName, '仅一块可行');

  // 原子性：库存状态与缺口前完全一致（无任何记录被预占）
  const after = listOffcuts();
  assert.deepEqual(
    after.offcuts.map((o) => [o.id, o.status]),
    before.offcuts.map((o) => [o.id, o.status])
  );
  assert.equal(after.summary.available, 2);
  assert.equal(after.summary.reserved, 0);
  assert.equal(out.allocationId, undefined);
});

test('预占缺口：纹向可行但几何受限于已预占库存（已预占余料不计候选）', () => {
  const { offcut: oc } = createOffcut({ width: 300, height: 300, paperGrain: 'along-width' });
  // 第一次预占成功
  const ok = allocateOffcuts({ width: 200, height: 80, quantity: 1, grain: 'along-width' });
  assert.equal(ok.status, 'fulfilled');
  // 同样需求再来：唯一余料已预占
  const again = allocateOffcuts({ width: 200, height: 80, quantity: 1, grain: 'along-width' });
  assert.equal(again.status, 'shortfall');
  assert.equal(again.feasibleCount, 0);
  assert.equal(again.unavailableReserved, 1);
  assert.equal(again.shortfall, 1);
  // 原预占保持不变（缺口请求不得影响已占用记录）
  const rec = listOffcuts({ status: 'reserved' }).offcuts[0];
  assert.equal(rec.id, oc.id);
  assert.equal(rec.reservation.allocationId, ok.allocationId);
});

test('预占缺口明细：几何可行但纹向不允许计入 blockedByGrain', () => {
  // 纸沿高：成品要求沿自身宽仅能旋转（成品宽 ∥ 纸高）
  createOffcut({ width: 200, height: 100, paperGrain: 'along-height' });
  // 200×80 成品沿自身宽：需要旋转（placedW=80, placedH=200）→ 需要 h>=200，放不下
  const out = allocateOffcuts({ width: 200, height: 80, quantity: 1, grain: 'along-width' });
  assert.equal(out.status, 'shortfall');
  assert.equal(out.blockedByGrain, 1);
});

test('预占校验：宽高与数量非法抛错', () => {
  createOffcut({ width: 300, height: 300 });
  assert.throws(() => allocateOffcuts({ width: 0, height: 10, quantity: 1 }), /正数/);
  assert.throws(() => allocateOffcuts({ width: 10, height: 10, quantity: 0 }), /正整数/);
  assert.throws(() => allocateOffcuts({ width: 10, height: 10, quantity: 1.5 }), /正整数/);
  assert.throws(() => allocateOffcuts({ width: 10, height: 10, quantity: 1, grain: 'x' }), /纹向/);
});

/* ---------------- 释放预占 ---------------- */

test('释放：按预占单号释放整单全部余料', () => {
  createOffcut({ width: 300, height: 300 });
  createOffcut({ width: 250, height: 250 });
  const out = allocateOffcuts({ width: 100, height: 100, quantity: 2, ref: 'WO-1' });
  assert.equal(out.summary.reserved, 2);

  const rel = releaseAllocations({ allocationIds: [out.allocationId] });
  assert.equal(rel.releasedCount, 2);
  assert.deepEqual(rel.allocationIds, [out.allocationId]);
  assert.equal(listOffcuts({ status: 'reserved' }).count, 0);
  assert.equal(listOffcuts({ status: 'available' }).count, 2);
  const rec = listOffcuts().offcuts.find((o) => o.id === rel.offcutIds[0]);
  assert.equal(rec.status, 'available');
  assert.equal(rec.reservation, null);
});

test('释放：按余料编号释放单条，重复编号去重', () => {
  createOffcut({ width: 300, height: 300 });
  createOffcut({ width: 250, height: 250 });
  const out = allocateOffcuts({ width: 100, height: 100, quantity: 2 });
  const id = out.reserved[0].offcutId;
  const rel = releaseAllocations({ offcutIds: [id, id] });
  assert.equal(rel.releasedCount, 1);
  assert.equal(listOffcuts({ status: 'reserved' }).count, 1);
});

test('释放校验：单号/余料编号不存在、对未预占记录释放均抛错且不改动库存', () => {
  createOffcut({ width: 300, height: 300 });
  const before = listOffcuts().summary;
  assert.throws(() => releaseAllocations({ allocationIds: ['AL-999999'] }), /不存在或已释放/);
  assert.throws(() => releaseAllocations({ offcutIds: ['OC-999999'] }), /余料编号不存在/);
  const availableId = listOffcuts({ status: 'available' }).offcuts[0].id;
  assert.throws(() => releaseAllocations({ offcutIds: [availableId] }), /未处于预占/);
  assert.throws(() => releaseAllocations({}), /需提供/);
  // 全部失败时库存不变
  assert.deepEqual(listOffcuts().summary, before);
});

test('释放与再预占：释放后余料可再次被选中', () => {
  createOffcut({ width: 200, height: 200 });
  const first = allocateOffcuts({ width: 150, height: 150, quantity: 1 });
  assert.equal(first.status, 'fulfilled');
  const gap = allocateOffcuts({ width: 150, height: 150, quantity: 1 });
  assert.equal(gap.status, 'shortfall');
  releaseAllocations({ allocationIds: [first.allocationId] });
  const again = allocateOffcuts({ width: 150, height: 150, quantity: 1 });
  assert.equal(again.status, 'fulfilled');
  assert.equal(again.reserved[0].offcutId, first.reserved[0].offcutId);
});

/* ---------------- 批量登记原子性 ---------------- */

test('批量登记原子性：后一张余料越界时整批不写入，序号不前进，重试无跳过/错位', () => {
  const goodSheet = {
    paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
    frees: [{ x: 0, y: 0, w: 50, h: 40 }],
  };
  const badSheet = {
    paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
    frees: [{ x: 150, y: 0, w: 60, h: 40 }], // 150+60=210 越出纸面
  };
  // 缺省批次号：失败不得消耗批次序号与余料序号
  assert.throws(
    () => ingestOffcuts({ layout: { sheets: [goodSheet, badSheet] } }),
    /超出纸面/
  );
  assert.equal(listOffcuts().count, 0);

  // 修正后重试：无跳过记录、余料编号从 1 开始、批次号也是第 1 个
  const retry = ingestOffcuts({ layout: { sheets: [goodSheet] } });
  assert.equal(retry.ingested, 1);
  assert.equal(retry.skipped, 0);
  assert.deepEqual(retry.offcutIds, ['OC-000001']);
  assert.equal(retry.batchId, 'BATCH-000001');
});

test('批量登记原子性：舍入后为零或舍入后越界的余料使整批不生效，编号不前进', () => {
  const goodSheet = {
    paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
    frees: [{ x: 0, y: 0, w: 50, h: 40 }],
  };
  // 极小正数余料：按 0.001mm 落盘精度舍入后为零
  const tinySheet = {
    paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
    frees: [{ x: 100, y: 0, w: 0.0004, h: 40 }],
  };
  assert.throws(
    () => ingestOffcuts({ layout: { sheets: [goodSheet, tinySheet] } }),
    /舍入后为零/
  );
  assert.equal(listOffcuts().count, 0);

  // 舍入后越出纸面：x 舍入为 150.001，150.001+50 越出 200 宽纸面
  const overflowSheet = {
    paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
    frees: [{ x: 150.0006, y: 0, w: 50, h: 40 }],
  };
  assert.throws(
    () => ingestOffcuts({ layout: { sheets: [goodSheet, overflowSheet] } }),
    /超出纸面/
  );
  assert.equal(listOffcuts().count, 0);

  // 修正后重试：无跳过记录、余料编号与批次号均从 1 开始
  const retry = ingestOffcuts({ layout: { sheets: [goodSheet] } });
  assert.equal(retry.ingested, 1);
  assert.equal(retry.skipped, 0);
  assert.deepEqual(retry.offcutIds, ['OC-000001']);
  assert.equal(retry.batchId, 'BATCH-000001');
});

test('单张 / 多纸型 / 比选登记同样原子：任一余料无效整批不写入', () => {
  const paper = { width: 200, height: 100, kerf: 0, grain: 'along-width' };
  const valid = { x: 0, y: 0, w: 50, h: 40 };
  const invalid = { x: 180, y: 0, w: 50, h: 40 }; // 180+50=230 越出纸面

  // 单张：frees 中后一条无效
  assert.throws(
    () => ingestOffcuts({ layout: { paper, frees: [valid, invalid] } }),
    /超出纸面/
  );
  assert.equal(listOffcuts().count, 0);

  // 多纸型成本：第二张纸的 layout 含无效余料
  const costResult = {
    sheets: [
      { round: 1, paperId: 'P1', paperName: '大纸', layout: { paper, frees: [valid] } },
      { round: 2, paperId: 'P2', paperName: '小纸', layout: { paper, frees: [invalid] } },
    ],
  };
  assert.throws(() => ingestOffcuts({ layout: costResult }), /超出纸面/);
  assert.equal(listOffcuts().count, 0);

  // 方案比选：中选布局含无效余料
  const compare = { best: { layout: { paper, frees: [invalid] } }, candidates: [] };
  assert.throws(() => ingestOffcuts({ layout: compare }), /超出纸面/);
  assert.equal(listOffcuts().count, 0);

  // 全部失败后序号未消耗：手工录入仍从 OC-000001 开始
  const { offcut } = createOffcut({ width: 10, height: 10 });
  assert.equal(offcut.id, 'OC-000001');
});

test('登记失败不影响已预占状态；显式批次号重试不产生跳过记录', () => {
  createOffcut({ width: 300, height: 300 });
  const alloc = allocateOffcuts({ width: 100, height: 100, quantity: 1 });
  assert.equal(alloc.status, 'fulfilled');

  const sheet = {
    paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
    frees: [{ x: 0, y: 0, w: 50, h: 40 }],
  };
  const badSheet = {
    paper: { width: 200, height: 100, kerf: 0, grain: 'along-width' },
    frees: [{ x: 0, y: 0, w: 500, h: 40 }], // 越出纸面
  };
  const before = listOffcuts();
  assert.throws(
    () => ingestOffcuts({ layout: { sheets: [sheet, badSheet] }, batchId: 'RETRY-1' }),
    /超出纸面/
  );
  // 库存与预占状态完全不变
  assert.deepEqual(listOffcuts(), before);
  assert.equal(listOffcuts({ status: 'reserved' }).count, 1);

  // 同一显式批次号修正后重试：第一张纸的余料未被“登记过”，无跳过、编号连续
  const retry = ingestOffcuts({ layout: { sheets: [sheet] }, batchId: 'RETRY-1' });
  assert.equal(retry.ingested, 1);
  assert.equal(retry.skipped, 0);
  assert.deepEqual(retry.offcutIds, ['OC-000002']); // 手工录入占 1 号，失败未消耗序号
});

/* ---------------- 去重与确定性 ---------------- */

test('同批次同自由矩形重复登记去重，不同批次保留', () => {
  const r = layout({
    paperW: 200, paperH: 150, kerf: 2,
    products: [{ width: 60, height: 60, quantity: 2 }],
  });
  const o1 = ingestOffcuts({ layout: r, batchId: 'DUP' });
  const o2 = ingestOffcuts({ layout: r, batchId: 'DUP' });
  assert.equal(o2.ingested, 0);
  assert.equal(o2.skipped, o1.ingested);
  assert.equal(listOffcuts().count, o1.ingested);

  // 不同批次号视为不同来源，允许再登记
  const o3 = ingestOffcuts({ layout: r, batchId: 'DUP-2' });
  assert.equal(o3.ingested, o1.ingested);
  assert.equal(listOffcuts().count, o1.ingested * 2);
});

test('编号单调且多次预占/释放顺序确定', () => {
  createOffcut({ width: 500, height: 500 });
  const a = allocateOffcuts({ width: 10, height: 10, quantity: 1 });
  releaseAllocations({ allocationIds: [a.allocationId] });
  const b = allocateOffcuts({ width: 10, height: 10, quantity: 1 });
  assert.notEqual(a.allocationId, b.allocationId);
  assert.ok(b.allocationId > a.allocationId);
});

/* ---------------- 整单分组不随列表筛选裁剪 ---------------- */

test('查询：同一预占单含大小不同余料时，最小尺寸筛选只裁剪明细，整单分组仍是完整两块', () => {
  createOffcut({ paperName: '大块', width: 300, height: 200 }); // OC-000001
  createOffcut({ paperName: '小块', width: 50, height: 40 }); // OC-000002
  const alloc = allocateOffcuts({ width: 30, height: 30, quantity: 2, grain: 'any' });
  assert.equal(alloc.status, 'fulfilled');
  assert.equal(alloc.reservedCount, 2);

  // 最小尺寸筛选后明细只剩大块一块
  const filtered = listOffcuts({ status: 'reserved', minW: 100, minH: 100 });
  assert.equal(filtered.count, 1);
  assert.equal(filtered.offcuts[0].id, 'OC-000001');

  // 同次读取返回的整单分组不被筛选裁剪：总块数为 2，组内两块编号齐全
  assert.equal(filtered.allocationGroups.length, 1);
  const group = filtered.allocationGroups[0];
  assert.equal(group.allocationId, alloc.allocationId);
  assert.equal(group.count, 2);
  assert.deepEqual(group.offcuts.map((o) => o.id), ['OC-000001', 'OC-000002']);
  assert.ok(group.offcuts.every((o) =>
    o.status === 'reserved' && o.reservation.allocationId === alloc.allocationId));
});

test('查询：无匹配明细（可用筛选 / 尺寸筛掉全部 / 关键字无命中）时整单分组仍可见', () => {
  createOffcut({ paperName: '大块', width: 300, height: 200 });
  createOffcut({ paperName: '小块', width: 50, height: 40 });
  const alloc = allocateOffcuts({ width: 30, height: 30, quantity: 2, ref: 'WO-X' });

  // 只看可用：明细中没有任何已预占记录
  const onlyAvailable = listOffcuts({ status: 'available' });
  assert.equal(onlyAvailable.count, 0);
  assert.equal(onlyAvailable.allocationGroups.length, 1);
  assert.equal(onlyAvailable.allocationGroups[0].count, 2);

  // 最小尺寸把两块都筛掉
  const tooBig = listOffcuts({ minW: 1000, minH: 1000 });
  assert.equal(tooBig.count, 0);
  assert.equal(tooBig.allocationGroups.length, 1);
  assert.deepEqual(
    tooBig.allocationGroups[0].offcuts.map((o) => o.id),
    ['OC-000001', 'OC-000002']
  );

  // 关键字无命中
  const noKw = listOffcuts({ q: '不存在的纸型关键字' });
  assert.equal(noKw.count, 0);
  assert.equal(noKw.allocationGroups[0].allocationId, alloc.allocationId);
  assert.equal(noKw.allocationGroups[0].ref, 'WO-X');
});

test('查询：多个预占单分组按单号升序、组内按余料编号升序；无预占时为空数组', () => {
  assert.deepEqual(listOffcuts().allocationGroups, []);

  createOffcut({ width: 300, height: 300 }); // OC-1
  createOffcut({ width: 250, height: 250 }); // OC-2
  createOffcut({ width: 200, height: 200 }); // OC-3
  // 择优先取剩余面积更小（即更小）的余料：首单占用 OC-3、OC-2
  const first = allocateOffcuts({ width: 50, height: 50, quantity: 2 }); // AL-1
  const second = allocateOffcuts({ width: 50, height: 50, quantity: 1 }); // AL-2: OC-1

  const groups = listOffcuts().allocationGroups;
  assert.deepEqual(groups.map((g) => g.allocationId), [first.allocationId, second.allocationId]);
  assert.deepEqual(groups[0].offcuts.map((o) => o.id), ['OC-000002', 'OC-000003']);
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[1].offcuts.map((o) => o.id), ['OC-000001']);
  assert.equal(groups[1].count, 1);
  // 分组汇总携带成品尺寸 / 单据 / 预占时间（取自组内记录，同单这些字段一致）
  assert.equal(groups[0].product.width, 50);
  assert.ok(groups[0].createdAt);

  // 释放整单后分组随之消失（同次库存读取的汇总与明细一致）
  releaseAllocations({ allocationIds: [first.allocationId] });
  const after = listOffcuts();
  assert.deepEqual(after.allocationGroups.map((g) => g.allocationId), [second.allocationId]);
  assert.equal(after.summary.reserved, 1);
});
