'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layoutBatch } = require('../src/packer');
const { stackSchedule } = require('../src/stack');
const { workOrder } = require('../src/workorder');
const { samplingPlan } = require('../src/sampling');

/** 真实排程 + 工单夹具（多张纸、多把刀） */
function realWorkOrder(opts = {}) {
  const r = layoutBatch({
    paperW: 420, paperH: 300, kerf: 2, maxSheets: 6,
    products: [
      { width: 150, height: 120, quantity: 24 },
      { width: 80, height: 60, quantity: 30 },
    ],
  });
  const schedule = stackSchedule({ stackLimit: opts.stackLimit || 2, sheets: r.sheets });
  const wo = workOrder({
    schedule,
    maxCutsPerShift: opts.maxCutsPerShift || 4,
    maxSheetsPerBatch: opts.maxSheetsPerBatch,
  });
  return { schedule, wo };
}

/**
 * 由“批次 → 成员列表”构造排程与全分配工单（刀号按批次顺序连续）。
 * @param {Array<Array<[number, number]>>} batches
 */
function buildAssigned(batches) {
  const schedule = {
    source: 'batch',
    stackLimit: batches.reduce((m, members) => Math.max(m, members.length), 1),
    batches: batches.map((members, i) => ({
      batchNo: i + 1,
      members: members.map(([sheetIndex, cutNo]) => ({ sheetIndex, cutNo })),
    })),
  };
  const wo = {
    source: 'batch',
    shifts: [{
      shiftNo: 1,
      cutsTotal: batches.length,
      cuts: batches.map((members, i) => ({
        shiftNo: 1,
        cutInShift: i + 1,
        cutNo: i + 1,
        batchNo: i + 1,
        members: members.map(([sheetIndex, cutNo]) => ({ sheetIndex, cutNo })),
      })),
    }],
    unassigned: [],
  };
  return { schedule, wo };
}

/* ---------------- 真实流水线上的基本性质 ---------------- */

test('裁切抽检：真实工单上结构完整、覆盖率守恒、逐轮新增非负且累计覆盖递增', () => {
  const { schedule, wo } = realWorkOrder();
  const plan = samplingPlan({ workOrder: wo, schedule, maxSamples: 3 });

  assert.strictEqual(plan.summary.assignedCutsTotal, wo.summary.batchesAssigned);
  assert.strictEqual(plan.summary.sheetsSelected, plan.sheets.length);
  assert.strictEqual(plan.summary.roundsTotal, plan.rounds.length);

  let acc = 0;
  plan.rounds.forEach((rd) => {
    assert.ok(rd.newCoveredCuts >= 1, '每轮必须有新增覆盖');
    acc += rd.newCoveredCuts;
    assert.strictEqual(rd.coveredAfter, acc);
    assert.ok(rd.tieBreak.tiedOnNewCovered >= 1);
    assert.ok(rd.tieBreak.tiedOnTotalCuts >= 1);
    assert.ok(rd.tieBreak.tiedOnTotalCuts <= rd.tieBreak.tiedOnNewCovered);
    assert.ok(rd.note.includes(`第 ${rd.sheetIndex} 张纸`));
  });
  assert.strictEqual(plan.summary.coveredCuts, acc);
  assert.strictEqual(
    plan.summary.coveredCuts + plan.summary.uncoveredCuts,
    plan.summary.assignedCutsTotal
  );
  assert.strictEqual(
    plan.summary.coverageRate,
    Math.round((acc / plan.summary.assignedCutsTotal) * 10000) / 10000
  );

  // 每张抽中纸的覆盖刀次恰好是它在工单中参与的已分配刀次
  const expected = new Map();
  wo.shifts.forEach((shift) => shift.cuts.forEach((c) => {
    c.members.forEach((m) => {
      if (!expected.has(m.sheetIndex)) expected.set(m.sheetIndex, new Set());
      expected.get(m.sheetIndex).add(c.cutNo);
    });
  }));
  plan.sheets.forEach((sh) => {
    assert.deepStrictEqual(
      sh.cuts.map((c) => c.cutNo),
      [...expected.get(sh.sheetIndex)].sort((a, b) => a - b)
    );
    assert.strictEqual(sh.cutCount, expected.get(sh.sheetIndex).size);
  });

  // 未覆盖刀次与覆盖刀次不重不漏
  const coveredNos = new Set();
  plan.sheets.forEach((sh) => sh.cuts.forEach((c) => coveredNos.add(c.cutNo)));
  assert.strictEqual(coveredNos.size, acc);
  plan.uncoveredCuts.forEach((c) => assert.ok(!coveredNos.has(c.cutNo)));
  assert.strictEqual(plan.uncoveredCuts.length, plan.summary.assignedCutsTotal - acc);
});

test('裁切抽检：达到用纸上限停止（max-samples），上限足够时覆盖完成（covered、覆盖率 1）', () => {
  const { schedule, wo } = realWorkOrder();

  const capped = samplingPlan({ workOrder: wo, schedule, maxSamples: 1 });
  assert.strictEqual(capped.stopReason, 'max-samples');
  assert.strictEqual(capped.summary.sheetsSelected, 1);
  assert.ok(capped.summary.uncoveredCuts > 0);
  assert.ok(capped.summary.coverageRate < 1);

  const full = samplingPlan({ workOrder: wo, schedule, maxSamples: 500 });
  assert.strictEqual(full.stopReason, 'covered');
  assert.strictEqual(full.summary.coverageRate, 1);
  assert.strictEqual(full.uncoveredCuts.length, 0);
  // 抽中纸张数不超过参与纸张数，且所有已分配刀次确实被覆盖
  const withCuts = new Set();
  wo.shifts.forEach((shift) => shift.cuts.forEach((c) =>
    c.members.forEach((m) => withCuts.add(m.sheetIndex))));
  assert.ok(full.sheets.length <= withCuts.size);
  assert.strictEqual(full.summary.coveredCuts, full.summary.assignedCutsTotal);
});

test('裁切抽检：同输入两次运行结果完全一致（确定性）', () => {
  const { schedule, wo } = realWorkOrder();
  const a = samplingPlan({ workOrder: wo, schedule, maxSamples: 3 });
  const b = samplingPlan({ workOrder: wo, schedule, maxSamples: 3 });
  assert.deepStrictEqual(b, a);
});

/* ---------------- 逐轮决胜规则 ---------------- */

test('裁切抽检：新增覆盖数相同 → 参与刀次总数多者优先', () => {
  // 首轮 s4 独占 5 把刀胜出并覆盖 c1、c2；此后：
  //   s1 参与 c1,c2,c4,c5（总 4，剩余新增 2：c4,c5）
  //   s2 参与 c1,c4,c6   （总 3，剩余新增 2：c4,c6）
  // 第 2 轮新增数同为 2，s1 参与总数更多而胜出。
  const { schedule, wo } = buildAssigned([
    [[4, 1], [1, 1], [2, 1]],   // c1
    [[4, 2], [1, 2]],           // c2
    [[4, 3]],                   // c3
    [[1, 4], [2, 2]],           // c4
    [[1, 5]],                   // c5
    [[2, 3]],                   // c6
    [[4, 4]],                   // c7
    [[4, 5]],                   // c8
  ]);
  const plan = samplingPlan({ workOrder: wo, schedule, maxSamples: 500 });
  assert.deepStrictEqual(plan.rounds.map((r) => r.sheetIndex), [4, 1, 2]);
  const second = plan.rounds[1];
  assert.strictEqual(second.newCoveredCuts, 2);
  assert.strictEqual(second.totalParticipatedCuts, 4);
  assert.strictEqual(second.tieBreak.tiedOnNewCovered, 2);
  assert.strictEqual(second.tieBreak.tiedOnTotalCuts, 1);
  assert.strictEqual(plan.stopReason, 'covered');
  assert.strictEqual(plan.summary.coverageRate, 1);
});

test('裁切抽检：新增数与参与总数都相同 → 纸张序号小者优先', () => {
  // s1、s2、s3 同刀 c1；s4、s5 同刀 c2
  const { schedule, wo } = buildAssigned([
    [[1, 1], [2, 1], [3, 1]],
    [[4, 1], [5, 1]],
  ]);
  const one = samplingPlan({ workOrder: wo, schedule, maxSamples: 1 });
  assert.strictEqual(one.rounds[0].sheetIndex, 1);
  assert.strictEqual(one.rounds[0].newCoveredCuts, 1);
  assert.strictEqual(one.rounds[0].tieBreak.tiedOnNewCovered, 5);
  assert.strictEqual(one.rounds[0].tieBreak.tiedOnTotalCuts, 5);
  assert.ok(one.rounds[0].note.includes('纸张序号最小'));

  const two = samplingPlan({ workOrder: wo, schedule, maxSamples: 2 });
  assert.deepStrictEqual(two.rounds.map((r) => r.sheetIndex), [1, 4]);
  assert.strictEqual(two.summary.coverageRate, 1);
});

test('裁切抽检：新增覆盖数严格优先于参与总数（参与少但当前新增多者胜出）', () => {
  // 首轮 s1、s2 同为 12 把，s1 凭纸张序号入选并覆盖 c1..c12；
  // 第 2 轮：s2 参与 12 把但仅 c19、c20 未覆盖（新增 2），
  // s3 参与 8 把但有 c13..c18 共 6 把未覆盖（新增 6）——s3 参与总数更少却凭新增数胜出。
  const batches = [
    [[1, 1], [2, 1], [3, 7]], [[1, 2], [2, 2], [3, 8]],       // c1,c2: s1,s2,s3
    ...Array.from({ length: 8 }, (_, i) => [[1, i + 3], [2, i + 3]]), // c3..c10: s1,s2
    [[1, 11]], [[1, 12]],                                             // c11,c12: s1
    ...Array.from({ length: 6 }, (_, i) => [[3, i + 1]]),             // c13..c18: s3
    [[2, 11]], [[2, 12]],                                             // c19,c20: s2
  ];
  const { schedule, wo } = buildAssigned(batches);
  const plan = samplingPlan({ workOrder: wo, schedule, maxSamples: 500 });
  assert.strictEqual(plan.rounds[0].sheetIndex, 1);
  const second = plan.rounds[1];
  assert.strictEqual(second.sheetIndex, 3);
  assert.strictEqual(second.newCoveredCuts, 6);
  assert.strictEqual(second.totalParticipatedCuts, 8);
  // s2 虽参与 12 把但第 2 轮仅新增 2，故排在 s3 之后
  assert.deepStrictEqual(plan.rounds.map((r) => r.sheetIndex), [1, 3, 2]);
  assert.strictEqual(plan.stopReason, 'covered');
});

test('裁切抽检：已被覆盖的刀不再计入后续轮次新增', () => {
  // s1、s2 同刀 c1,c2；首轮 s1 全覆盖，s2 永不再被选中
  const { schedule, wo } = buildAssigned([
    [[1, 1], [2, 1]],
    [[1, 2], [2, 2]],
  ]);
  const plan = samplingPlan({ workOrder: wo, schedule, maxSamples: 500 });
  assert.deepStrictEqual(plan.sheets.map((s) => s.sheetIndex), [1]);
  assert.strictEqual(plan.rounds.length, 1);
  assert.strictEqual(plan.summary.coverageRate, 1);
});

/* ---------------- 未分配刀：单列且不计入分母 ---------------- */

test('裁切抽检：未分配整批不参与抽检、单列返回且不计入覆盖率分母', () => {
  const schedule = {
    source: 'batch', stackLimit: 3,
    batches: [
      { batchNo: 1, members: [{ sheetIndex: 1, cutNo: 1 }, { sheetIndex: 2, cutNo: 1 }, { sheetIndex: 3, cutNo: 1 }] },
      { batchNo: 2, members: [{ sheetIndex: 1, cutNo: 2 }, { sheetIndex: 2, cutNo: 2 }] },
      { batchNo: 3, members: [{ sheetIndex: 3, cutNo: 2 }] },
    ],
  };
  const wo = {
    source: 'batch',
    shifts: [{
      shiftNo: 1, cutsTotal: 2,
      cuts: [
        { shiftNo: 1, cutInShift: 1, cutNo: 1, batchNo: 2, members: [{ sheetIndex: 1, cutNo: 2 }, { sheetIndex: 2, cutNo: 2 }] },
        { shiftNo: 1, cutInShift: 2, cutNo: 2, batchNo: 3, members: [{ sheetIndex: 3, cutNo: 2 }] },
      ],
    }],
    unassigned: [
      { sheetIndex: 1, cutNo: 1, reason: 'over-capacity', detail: '超容量', batchNo: 1 },
      { sheetIndex: 2, cutNo: 1, reason: 'over-capacity', detail: '超容量', batchNo: 1 },
      { sheetIndex: 3, cutNo: 1, reason: 'over-capacity', detail: '超容量', batchNo: 1 },
    ],
  };
  const plan = samplingPlan({ workOrder: wo, schedule, maxSamples: 500 });
  assert.strictEqual(plan.summary.assignedCutsTotal, 2);
  assert.strictEqual(plan.summary.unassignedCuts, 3);
  assert.strictEqual(plan.summary.coverageRate, 1);
  // 每张纸的参与刀次只计已分配刀（cutNo 2），不含未分配的 cutNo 1
  plan.sheets.forEach((sh) => assert.strictEqual(sh.cutCount, 1));
  assert.deepStrictEqual(plan.unassigned.map((u) => [u.sheetIndex, u.cutNo, u.reason]), [
    [1, 1, 'over-capacity'], [2, 1, 'over-capacity'], [3, 1, 'over-capacity'],
  ]);
});

test('裁切抽检：合批刀次中的 blocked 成员刀不视为可覆盖成员', () => {
  // 批次 2 已分配，但其成员 3#2 同时在 unassigned（被阻断），可执行成员仅 1#2、2#2
  const schedule = {
    source: 'batch', stackLimit: 3,
    batches: [
      { batchNo: 1, members: [{ sheetIndex: 3, cutNo: 1 }] },
      { batchNo: 2, members: [{ sheetIndex: 1, cutNo: 2 }, { sheetIndex: 2, cutNo: 2 }, { sheetIndex: 3, cutNo: 2 }] },
    ],
  };
  const wo = {
    source: 'batch',
    shifts: [{
      shiftNo: 1, cutsTotal: 1,
      cuts: [
        { shiftNo: 1, cutInShift: 1, cutNo: 1, batchNo: 2,
          members: [{ sheetIndex: 1, cutNo: 2 }, { sheetIndex: 2, cutNo: 2 }, { sheetIndex: 3, cutNo: 2 }] },
      ],
    }],
    unassigned: [
      { sheetIndex: 3, cutNo: 1, reason: 'missing-parent', detail: '父刀缺失', batchNo: 1 },
      { sheetIndex: 3, cutNo: 2, reason: 'blocked', detail: '上游阻断', batchNo: 2 },
    ],
  };
  const plan = samplingPlan({ workOrder: wo, schedule, maxSamples: 500 });
  assert.strictEqual(plan.summary.assignedCutsTotal, 1);
  assert.strictEqual(plan.summary.coverageRate, 1);
  // 第 3 张纸没有任何可执行成员刀，不进入候选、不会被抽中
  assert.deepStrictEqual(plan.sheets.map((s) => s.sheetIndex), [1]);
  // 覆盖明细中的 members 已剔除 blocked 成员
  assert.deepStrictEqual(plan.sheets[0].cuts[0].members, [
    { sheetIndex: 1, cutNo: 2 }, { sheetIndex: 2, cutNo: 2 },
  ]);
  assert.strictEqual(plan.summary.unassignedCuts, 2);
});

/* ---------------- 覆盖明细字段透传 ---------------- */

test('裁切抽检：抽中纸张覆盖明细带全局刀号、来源批次与成员纸张', () => {
  const { schedule, wo } = realWorkOrder();
  const plan = samplingPlan({ workOrder: wo, schedule, maxSamples: 1 });
  const sh = plan.sheets[0];
  sh.cuts.forEach((c) => {
    assert.ok(Number.isInteger(c.cutNo) && c.cutNo >= 1);
    assert.ok(Number.isInteger(c.batchNo) && c.batchNo >= 1);
    assert.ok(Array.isArray(c.members) && c.members.length >= 1);
    c.members.forEach((m) => {
      assert.ok(Number.isInteger(m.sheetIndex) && Number.isInteger(m.cutNo));
    });
  });
});

/* ---------------- 400 校验 ---------------- */

test('裁切抽检：缺少 workOrder / schedule / maxSamples 返回 400 信息', () => {
  const { schedule, wo } = realWorkOrder();
  assert.throws(() => samplingPlan({}), /缺少工单结果/);
  assert.throws(() => samplingPlan({ workOrder: wo }), /缺少排程结果/);
  assert.throws(() => samplingPlan({ workOrder: wo, schedule: {} }), /缺少排程结果|没有任何刀次批次/);
  assert.throws(() => samplingPlan({ workOrder: wo, schedule }), /抽检用纸上限必须是正整数/);
});

test('裁切抽检：maxSamples 越界 / 非整数返回 400', () => {
  const { schedule, wo } = realWorkOrder();
  for (const v of [0, -3, 1.2, 'abc', {}, NaN, 501]) {
    assert.throws(() => samplingPlan({ workOrder: wo, schedule, maxSamples: v }), /抽检用纸上限/);
  }
});

test('裁切抽检：成员引用缺失（工单刀次引用排程中不存在的刀）返回 400', () => {
  const { schedule, wo } = realWorkOrder();
  const bad = JSON.parse(JSON.stringify(wo));
  bad.shifts[0].cuts[0].members.push({ sheetIndex: 999, cutNo: 1 });
  assert.throws(
    () => samplingPlan({ workOrder: bad, schedule, maxSamples: 3 }),
    /成员引用缺失/
  );

  // 未分配刀引用缺失
  const bad2 = JSON.parse(JSON.stringify(wo));
  bad2.unassigned.push({ sheetIndex: 999, cutNo: 2, reason: 'blocked' });
  assert.throws(
    () => samplingPlan({ workOrder: bad2, schedule, maxSamples: 3 }),
    /成员引用缺失/
  );
});

test('裁切抽检：重复归属（排程批次内 / 跨批 / 工单跨刀次）返回 400', () => {
  const { schedule, wo } = realWorkOrder();

  // 排程批次内成员重复
  const dupInBatch = JSON.parse(JSON.stringify(schedule));
  dupInBatch.batches[0].members.push({ ...dupInBatch.batches[0].members[0] });
  assert.throws(
    () => samplingPlan({ workOrder: wo, schedule: dupInBatch, maxSamples: 3 }),
    /批内成员重复/
  );

  // 同一刀出现在两个排程批次
  const dupAcrossBatch = JSON.parse(JSON.stringify(schedule));
  dupAcrossBatch.batches[1].members.push({ ...dupAcrossBatch.batches[0].members[0] });
  assert.throws(
    () => samplingPlan({ workOrder: wo, schedule: dupAcrossBatch, maxSamples: 3 }),
    /重复归属/
  );

  // 同一成员刀出现在两个工单刀次（成员从后一刀挪入 → 与该刀原批次不符时报不一致；
  // 构造成员完全相同的两把刀指向不同排程批以触发跨刀次重复）
  const dupCut = JSON.parse(JSON.stringify(wo));
  const [c1, c2] = [dupCut.shifts[0].cuts[0], dupCut.shifts[0].cuts[1]];
  c2.batchNo = c1.batchNo;
  c2.members = c1.members.map((m) => ({ ...m }));
  assert.throws(
    () => samplingPlan({ workOrder: dupCut, schedule, maxSamples: 3 }),
    /schedule\/workOrder 不一致/
  );
});

test('裁切抽检：schedule/workOrder 不一致（成员不符 / 批次缺失 / 未整批未分配）返回 400', () => {
  const { schedule, wo } = realWorkOrder();

  // 成员少一个
  const fewer = JSON.parse(JSON.stringify(wo));
  const removed = fewer.shifts[0].cuts[0].members.shift();
  assert.throws(
    () => samplingPlan({ workOrder: fewer, schedule, maxSamples: 3 }),
    /成员与排程批次不一致/
  );

  // 来源批次号不存在
  const wrongBatch = JSON.parse(JSON.stringify(wo));
  wrongBatch.shifts[0].cuts[0].batchNo = schedule.batches.length + 10;
  assert.throws(
    () => samplingPlan({ workOrder: wrongBatch, schedule, maxSamples: 3 }),
    /来源批次 .* 不在排程结果中/
  );

  // 全局刀号重复
  const dupNo = JSON.parse(JSON.stringify(wo));
  dupNo.shifts[0].cuts[1].cutNo = dupNo.shifts[0].cuts[0].cutNo;
  assert.throws(
    () => samplingPlan({ workOrder: dupNo, schedule, maxSamples: 3 }),
    /全局刀号重复/
  );

  // 未分配批次缺少整批登记
  const partial = JSON.parse(JSON.stringify(wo));
  if (partial.unassigned.length) {
    partial.unassigned.pop();
  }
  // 真实夹具通常全部已分配：手工构造一个整批未分配但漏登记的情形
  const s2 = {
    batches: [
      { batchNo: 1, members: [{ sheetIndex: 1, cutNo: 1 }] },
      { batchNo: 2, members: [{ sheetIndex: 1, cutNo: 2 }] },
    ],
  };
  const w2 = {
    shifts: [{ shiftNo: 1, cuts: [
      { shiftNo: 1, cutInShift: 1, cutNo: 1, batchNo: 2, members: [{ sheetIndex: 1, cutNo: 2 }] },
    ] }],
    unassigned: [], // 批次 1 整批未登记
  };
  assert.throws(
    () => samplingPlan({ workOrder: w2, schedule: s2, maxSamples: 3 }),
    /既未分配到任何班次，也未列入未分配刀/
  );
});

test('裁切抽检：非法 shifts / members / unassigned 结构返回 400', () => {
  const { schedule, wo } = realWorkOrder();

  assert.throws(
    () => samplingPlan({ workOrder: { shifts: 'no' }, schedule, maxSamples: 3 }),
    /缺少工单结果|shifts/
  );
  const noCuts = JSON.parse(JSON.stringify(wo));
  noCuts.shifts[0].cuts = null;
  assert.throws(() => samplingPlan({ workOrder: noCuts, schedule, maxSamples: 3 }), /cuts/);

  const badMember = JSON.parse(JSON.stringify(wo));
  badMember.shifts[0].cuts[0].members[0] = { sheetIndex: 0, cutNo: 1 };
  assert.throws(() => samplingPlan({ workOrder: badMember, schedule, maxSamples: 3 }), /成员/);

  const badUnassigned = JSON.parse(JSON.stringify(wo));
  badUnassigned.unassigned = [{ sheetIndex: 1 }];
  assert.throws(() => samplingPlan({ workOrder: badUnassigned, schedule, maxSamples: 3 }), /unassigned/);

  const sBad = { batches: [{ batchNo: 1 }] };
  assert.throws(() => samplingPlan({ workOrder: wo, schedule: sBad, maxSamples: 3 }), /members/);
});

test('裁切抽检：未分配刀重复登记返回 400', () => {
  const schedule = {
    batches: [{ batchNo: 1, members: [{ sheetIndex: 1, cutNo: 1 }] }],
  };
  const wo = { shifts: [], unassigned: [
    { sheetIndex: 1, cutNo: 1, reason: 'over-capacity', batchNo: 1 },
    { sheetIndex: 1, cutNo: 1, reason: 'blocked', batchNo: 1 },
  ] };
  assert.throws(() => samplingPlan({ workOrder: wo, schedule, maxSamples: 3 }), /未分配刀重复登记/);
});
