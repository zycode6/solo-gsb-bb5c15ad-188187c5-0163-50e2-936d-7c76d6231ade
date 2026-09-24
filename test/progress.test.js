'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layoutBatch } = require('../src/packer');
const { stackSchedule } = require('../src/stack');
const { workOrder } = require('../src/workorder');
const { workOrderProgress } = require('../src/progress');

const EPS = 1e-6;

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

/** 精简批次构造（同 workorder 测试夹具） */
function batchNode(no, members, extra = {}) {
  return {
    batchNo: no,
    orient: 'h', kerf: 0, position: 1,
    region: { w: 100, h: 100 }, cutLength: 100,
    totalLength: 100 * members.length, sheetCount: members.length,
    capped: false,
    members: members.map(([si, cn]) => ({ sheetIndex: si, cutNo: cn })),
    ...extra,
  };
}

/* ---------------- 基本结构与就绪判定 ---------------- */

test('现场进度：初始就绪刀次即无父刀的根刀，状态划分完整且不重不漏', () => {
  const { schedule, wo } = realWorkOrder();
  const p = workOrderProgress({ workOrder: wo, schedule, completed: [] });

  assert.strictEqual(p.dependencySource, 'dependencies');
  assert.strictEqual(p.cuts.length, wo.summary.batchesAssigned);
  assert.ok(p.ready.length >= 1);
  assert.strictEqual(p.blocked.length, wo.summary.batchesAssigned - p.ready.length);
  assert.deepStrictEqual(p.completed, []);

  const byNo = new Map(p.cuts.map((c) => [c.cutNo, c]));
  assert.ok(p.ready.every((n) => byNo.get(n).status === 'ready'));
  assert.ok(p.blocked.every((n) => byNo.get(n).status === 'blocked'));
  // 全局刀号有序、shift/batch 透传
  assert.deepStrictEqual(p.cuts.map((c) => c.cutNo), p.cuts.map((c) => c.cutNo).sort((a, b) => a - b));
  assert.ok(p.cuts.every((c) => Number.isInteger(c.shiftNo) && Number.isInteger(c.batchNo)));
  // 初始就绪刀必须没有任何待完成父刀与阻塞项
  assert.ok(p.ready.every((n) => byNo.get(n).waitingParents.length === 0
    && byNo.get(n).blockers.length === 0));
  // 阻塞刀至少带一个待完成父刀或阻塞项
  assert.ok(p.blocked.every((n) => {
    const c = byNo.get(n);
    return c.waitingParents.length + c.blockers.length > 0;
  }));
  // 统计
  assert.strictEqual(p.summary.cutsAssigned, wo.summary.batchesAssigned);
  assert.strictEqual(p.summary.cutsCompleted, 0);
  assert.strictEqual(p.summary.cutsReady, p.ready.length);
  assert.strictEqual(p.summary.cutsBlocked, p.blocked.length);
  assert.strictEqual(p.summary.cutsUnassigned, 0);
  assert.strictEqual(p.summary.completionRate, 0);
  assert.strictEqual(p.summary.fullCompletionRate, 0);
  assert.strictEqual(p.summary.perShift.length, wo.summary.shiftsTotal);
});

test('现场进度：沿就绪集合依次勾选可完成整单，最终各班/整单完成率均为 1', () => {
  const { schedule, wo } = realWorkOrder();
  const total = wo.summary.batchesAssigned;
  const done = [];
  let prevRate = -EPS;
  for (let i = 0; i < total + 1; i += 1) {
    const p = workOrderProgress({ workOrder: wo, schedule, completed: done });
    assert.ok(Math.abs(p.summary.completionRate - done.length / total) < 1e-3);
    assert.ok(p.summary.completionRate >= prevRate);
    prevRate = p.summary.completionRate;
    if (p.summary.completionRate === 1) {
      assert.strictEqual(done.length, total);
      assert.strictEqual(p.ready.length, 0);
      assert.strictEqual(p.blocked.length, 0);
      assert.strictEqual(p.summary.fullCompletionRate, 1);
      assert.strictEqual(p.summary.shiftsCompleted, p.summary.shiftsTotal);
      assert.ok(p.summary.perShift.every((s) => s.completionRate === 1));
      return;
    }
    assert.ok(p.ready.length > 0, '存在未完成刀时就绪集合不应提前为空');
    done.push(p.ready[0]);
  }
  assert.fail('未能沿就绪集合完成全部刀次');
});

test('现场进度：completed 缺省/为空等价，重复刀号去重且输出排序', () => {
  const { schedule, wo } = realWorkOrder();
  const p0 = workOrderProgress({ workOrder: wo, schedule });
  const p1 = workOrderProgress({ workOrder: wo, schedule, completed: null });
  assert.deepStrictEqual(p0.ready, p1.ready);
  const first = p0.ready[0];
  const p = workOrderProgress({ workOrder: wo, schedule, completed: [first, first] });
  assert.deepStrictEqual(p.completed, [first]);
  assert.strictEqual(p.summary.cutsCompleted, 1);
});

/* ---------------- 合批刀次：任一成员父刀未完成则整批不可就绪 ---------------- */

test('现场进度：合批刀次汇总全部成员父刀，成员父刀未完成时整批阻塞', () => {
  // 批1=[1,1] 批2=[2,1] 批3=[1,2]+[2,2]（两张纸子刀合批，各自父刀分别在全局1、2）
  const sched = {
    stackLimit: 2,
    dependencies: [[[2, 1]], [[2, 1]]],
    batches: [
      batchNode(1, [[1, 1]]),
      batchNode(2, [[2, 1]]),
      batchNode(3, [[1, 2], [2, 2]]),
    ],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10 });

  let p = workOrderProgress({ workOrder: wo, schedule: sched, completed: [] });
  assert.deepStrictEqual(p.ready, [1, 2]);
  assert.deepStrictEqual(p.blocked, [3]);
  const c3 = p.cuts.find((c) => c.cutNo === 3);
  assert.strictEqual(c3.sheetCount, 2);
  assert.deepStrictEqual(c3.waitingParents.map((x) => x.globalCutNo), [1, 2]);
  assert.deepStrictEqual(c3.blockers, []);

  // 只完成全局1：成员[2,2]的父刀（全局2）未完成 → 合批刀次仍不可就绪
  p = workOrderProgress({ workOrder: wo, schedule: sched, completed: [1] });
  assert.ok(!p.ready.includes(3));
  assert.ok(p.blocked.includes(3));
  assert.strictEqual(p.cuts.find((c) => c.cutNo === 3).status, 'blocked');

  // 两把父刀都完成后才可就绪，完成后进入 completed
  p = workOrderProgress({ workOrder: wo, schedule: sched, completed: [1, 2] });
  assert.deepStrictEqual(p.ready, [3]);
  p = workOrderProgress({ workOrder: wo, schedule: sched, completed: [1, 2, 3] });
  assert.strictEqual(p.cuts.find((c) => c.cutNo === 3).status, 'completed');
  assert.strictEqual(p.summary.completionRate, 1);
});

/* ---------------- 未知刀号 / 乱序完成 → 400 且指出缺失父刀 ---------------- */

test('现场进度：未知全局刀号、非正整数、非数组均抛错', () => {
  const { schedule, wo } = realWorkOrder();
  assert.throws(() => workOrderProgress({ workOrder: wo, schedule, completed: [99999] }), /未知全局刀号.*99999/);
  assert.throws(() => workOrderProgress({ workOrder: wo, schedule, completed: [0] }), /未知|正整数/);
  for (const bad of [-1, 1.5, '1', true, NaN]) {
    assert.throws(() => workOrderProgress({ workOrder: wo, schedule, completed: [bad] }), /正整数|未知/);
  }
  assert.throws(() => workOrderProgress({ workOrder: wo, schedule, completed: '1' }), /completed 必须是/);
  assert.throws(() => workOrderProgress({ workOrder: wo, schedule, completed: {} }), /completed 必须是/);
});

test('现场进度：父刀未完成却先完成子刀 → 抛错并逐条指出缺失父刀（全局刀号与纸张/原刀号）', () => {
  const sched = {
    stackLimit: 2,
    dependencies: [[[2, 1]], [[2, 1]]],
    batches: [
      batchNode(1, [[1, 1]]),
      batchNode(2, [[2, 1]]),
      batchNode(3, [[1, 2], [2, 2]]),
    ],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10 });

  // 全局3 的两个成员父刀（全局1、2）都未完成
  assert.throws(
    () => workOrderProgress({ workOrder: wo, schedule: sched, completed: [3] }),
    /全局刀次 3 缺少前置父刀.*全局刀次 1.*第 1 张纸第 1 号刀.*全局刀次 2.*第 2 张纸第 1 号刀/
  );
  // 只补一个父刀仍报错，并指出仍缺的另一个
  assert.throws(
    () => workOrderProgress({ workOrder: wo, schedule: sched, completed: [1, 3] }),
    /全局刀次 3 缺少前置父刀.*全局刀次 2/
  );
});

/* ---------------- 依赖未分配刀次 → 持续阻塞并标明原因 ---------------- */

test('现场进度：父刀超容量未分配时合批刀次持续阻塞，整单完成率不可达 100%', () => {
  // 批1（3张合批）超容量 → [1,1][2,1][3,1] 全部 over-capacity
  // 批2=[4,1] 正常；批3=[2,2]+[4,2]：[2,2] 的父刀 [2,1] 未分配，[4,2] 父刀为全局1
  const sched = {
    stackLimit: 3,
    dependencies: [[], [[2, 1]], [], [[2, 1]]],
    batches: [
      batchNode(1, [[1, 1], [2, 1], [3, 1]]),
      batchNode(2, [[4, 1]]),
      batchNode(3, [[2, 2], [4, 2]]),
    ],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10, maxSheetsPerBatch: 2 });
  assert.strictEqual(wo.summary.batchesAssigned, 2);
  assert.strictEqual(wo.summary.unassignedCuts, 4);

  const p0 = workOrderProgress({ workOrder: wo, schedule: sched, completed: [] });
  assert.deepStrictEqual(p0.ready, [1]);
  assert.deepStrictEqual(p0.blocked, [2]);
  const c2 = p0.cuts.find((c) => c.cutNo === 2);
  assert.deepStrictEqual(c2.waitingParents.map((x) => x.globalCutNo), [1]);
  assert.deepStrictEqual(c2.blockers.map((x) => `${x.sheetIndex}:${x.cutNo}:${x.reason}`), ['2:1:over-capacity']);
  assert.ok(/超过每批最多/.test(c2.blockers[0].detail));
  assert.strictEqual(p0.summary.cutsUnassigned, 4);
  assert.strictEqual(p0.summary.fullCompletionRate, 0);

  // 即使可分配父刀全部完成，合批刀次仍因未分配父刀持续阻塞
  const p1 = workOrderProgress({ workOrder: wo, schedule: sched, completed: [1] });
  assert.deepStrictEqual(p1.ready, []);
  assert.deepStrictEqual(p1.blocked, [2]);
  // 已分配完成率 0.5，整单完成率 1/6
  assert.ok(Math.abs(p1.summary.completionRate - 0.5) < 1e-3);
  assert.ok(Math.abs(p1.summary.fullCompletionRate - 1 / 6) < 1e-3);

  // 现场无法通过勾选完成该刀：错误中给出未分配父刀与原因
  assert.throws(
    () => workOrderProgress({ workOrder: wo, schedule: sched, completed: [1, 2] }),
    /全局刀次 2 缺少前置父刀.*第 2 张纸第 1 号刀（超每批容量）/
  );
});

test('现场进度：成员父刀不在排程中（missing-parent）时该刀持续阻塞并标明', () => {
  // 批1=[1,1] 批2=[2,1] 批3=[1,2]+[2,2]：
  // [1,2] 声称父刀为不存在的 9 号刀（工单 missing-parent），[2,2] 父刀为全局2
  const sched = {
    stackLimit: 2,
    dependencies: [[[2, 9]], [[2, 1]]],
    batches: [
      batchNode(1, [[1, 1]]),
      batchNode(2, [[2, 1]]),
      batchNode(3, [[1, 2], [2, 2]]),
    ],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10 });
  // 批次 3 因 [2,2] 仍活跃而排入，但成员 [1,2] 为 missing-parent
  const p = workOrderProgress({ workOrder: wo, schedule: sched, completed: [1, 2] });
  const c3 = p.cuts.find((c) => c.cutNo === 3);
  assert.ok(c3, '批3 必须已分配');
  // [2,2] 的父刀（全局2）已在 completed 中，waitingParents 仍按依赖列出
  assert.deepStrictEqual(c3.waitingParents.map((x) => x.globalCutNo), [2]);
  assert.ok(c3.waitingParents[0].globalCutNo === 2 && p.completed.includes(2));
  const miss = c3.blockers.find((b) => b.sheetIndex === 1 && b.cutNo === 9);
  assert.ok(miss, '缺失父刀（第1张纸第9号刀）必须列入 blockers');
  assert.strictEqual(miss.reason, 'missing-parent');
  assert.ok(/第 9 号刀/.test(miss.detail));
  assert.ok(p.blocked.includes(3));
});

test('现场进度：上游 blocked 沿父刀链传播，blockers 给出被阻断原因', () => {
  // 批1（3张合批）超容量 → [1,1][2,1][3,1] over-capacity
  // 批2=[1,2]+[4,1]：[1,2] 的父刀 [1,1] 未分配（over-capacity），[4,1] 是根成员 → 节点活跃，整批被 [1,1] 阻塞
  // 批3=[1,3]+[4,2]：[1,3] 父刀 [1,2]（blocked 未分配），[4,2] 父刀为全局1 内的 [4,1]
  // 批4=[5,1]：无关根刀
  const sched = {
    stackLimit: 3,
    dependencies: [[[2, 1], [3, 2]], [], [], [[2, 1]], []],
    batches: [
      batchNode(1, [[1, 1], [2, 1], [3, 1]]),
      batchNode(2, [[1, 2], [4, 1]]),
      batchNode(3, [[1, 3], [4, 2]]),
      batchNode(4, [[5, 1]]),
    ],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10, maxSheetsPerBatch: 2 });
  const ua = new Map(wo.unassigned.map((u) => [`${u.sheetIndex}:${u.cutNo}`, u.reason]));
  assert.strictEqual(ua.get('1:1'), 'over-capacity');
  assert.strictEqual(ua.get('1:2'), 'blocked'); // 上游 over-capacity 沿父刀链传播为 blocked
  assert.strictEqual(ua.get('1:3'), 'blocked');
  assert.strictEqual(wo.summary.batchesAssigned, 3);

  const p = workOrderProgress({ workOrder: wo, schedule: sched, completed: [] });
  assert.deepStrictEqual(p.ready, [3]); // 全局3 = 批4 根刀
  // 全局1 = 批2：成员 [1,2] 携带未分配父刀 [1,1]（over-capacity），整批持续阻塞
  const c1 = p.cuts.find((c) => c.cutNo === 1);
  assert.strictEqual(c1.batchNo, 2);
  assert.deepStrictEqual(c1.blockers.map((b) => `${b.sheetIndex}:${b.cutNo}:${b.reason}`), ['1:1:over-capacity']);
  assert.ok(p.blocked.includes(1));
  // 全局2 = 批3：[4,2] 的父刀 [4,1] 在全局1；[1,3] 的父刀 [1,2] 在上游被 blocked
  const c2 = p.cuts.find((c) => c.cutNo === 2);
  assert.strictEqual(c2.batchNo, 3);
  assert.deepStrictEqual(c2.waitingParents.map((w) => `${w.sheetIndex}:${w.cutNo}`), ['4:1']);
  assert.deepStrictEqual(c2.waitingParents.map((w) => w.globalCutNo), [1]);
  assert.ok(c2.blockers.some((b) => b.sheetIndex === 1 && b.cutNo === 2 && b.reason === 'blocked'),
    `成员 [1,3] 的父刀 [1,2]（上游 blocked）必须列入 blockers：${JSON.stringify(c2.blockers)}`);
  assert.ok(p.blocked.includes(2));
  // 强行勾选全局1会被服务端以“缺少前置父刀（超容量）”拒绝
  assert.throws(
    () => workOrderProgress({ workOrder: wo, schedule: sched, completed: [1] }),
    /缺少前置父刀.*超每批容量/
  );
});

test('现场进度：未分配成员出现在活跃合批刀次成员表中时，不会被误判为已分配父刀', () => {
  // 批1（3张）超容量；批2=[1,2]+[4,1]：[1,2] 自身 blocked 未分配，但节点因 [4,1] 活跃；
  // 批3=[1,3]+[4,2]：[1,3] 的父刀 [1,2] 必须识别为未分配阻塞，而不是“全局刀次1”
  const sched = {
    stackLimit: 3,
    dependencies: [[[2, 1], [3, 2]], [], [], [[2, 1]], []],
    batches: [
      batchNode(1, [[1, 1], [2, 1], [3, 1]]),
      batchNode(2, [[1, 2], [4, 1]]),
      batchNode(3, [[1, 3], [4, 2]]),
      batchNode(4, [[5, 1]]),
    ],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10, maxSheetsPerBatch: 2 });
  const p = workOrderProgress({ workOrder: wo, schedule: sched, completed: [] });
  const cut2 = p.cuts.find((c) => c.cutNo === 2);
  assert.deepStrictEqual(cut2.waitingParents.map((w) => `${w.sheetIndex}:${w.cutNo}`), ['4:1']);
  assert.ok(cut2.blockers.some((b) => b.sheetIndex === 1 && b.cutNo === 2 && b.reason === 'blocked'));
  assert.deepStrictEqual(p.ready, [3]);
});

/* ---------------- 无 schedule：推断依赖与 sheets 回退 ---------------- */

test('现场进度：不传 schedule 时按批次先后推断（含未分配刀），语义一致', () => {
  const sched = {
    stackLimit: 3,
    dependencies: [[], [[2, 1]], [], [[2, 1]]],
    batches: [
      batchNode(1, [[1, 1], [2, 1], [3, 1]]),
      batchNode(2, [[4, 1]]),
      batchNode(3, [[2, 2], [4, 2]]),
    ],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10, maxSheetsPerBatch: 2 });
  const p = workOrderProgress({ workOrder: wo });
  assert.strictEqual(p.dependencySource, 'inferred');
  // 推断链：纸4 的 [4,2]→[4,1]（全局1）；纸2 的 [2,2]→[2,1]（未分配 over-capacity）
  const c2 = p.cuts.find((c) => c.cutNo === 2);
  assert.deepStrictEqual(c2.waitingParents.map((x) => x.globalCutNo), [1]);
  assert.deepStrictEqual(c2.blockers.map((x) => x.reason), ['over-capacity']);
  assert.deepStrictEqual(p.ready, [1]);
});

test('现场进度：未带 schedule 但带 sheets 时服务端先排程（dependencies 直供）', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 200, kerf: 3, maxSheets: 4,
    products: [{ width: 100, height: 80, quantity: 24 }],
  });
  const schedule = stackSchedule({ stackLimit: 3, sheets: r.sheets });
  const wo = workOrder({ schedule, maxCutsPerShift: 4 });
  const p = workOrderProgress({ workOrder: wo, sheets: r.sheets, stackLimit: 3 });
  assert.strictEqual(p.dependencySource, 'dependencies');
  assert.ok(p.cuts.length === wo.summary.batchesAssigned);
});

/* ---------------- 班次统计 / 确定性 ---------------- */

test('现场进度：各班完成率独立统计、班次完成数随勾选推进', () => {
  const { schedule, wo } = realWorkOrder({ maxCutsPerShift: 3 });
  assert.ok(wo.summary.shiftsTotal >= 2);
  // 完成第一班全部刀
  const firstShiftCutNos = wo.shifts[0].cuts.map((c) => c.cutNo);
  const p = workOrderProgress({ workOrder: wo, schedule, completed: firstShiftCutNos });
  assert.deepStrictEqual(p.summary.perShift[0], {
    shiftNo: 1,
    cutsTotal: firstShiftCutNos.length,
    cutsCompleted: firstShiftCutNos.length,
    completionRate: 1,
  });
  assert.strictEqual(p.summary.shiftsCompleted, 1);
  assert.ok(p.summary.perShift[1].completionRate === 0);
});

test('现场进度：同输入两次运行结果完全一致（确定性）', () => {
  const { schedule, wo } = realWorkOrder();
  const done = workOrderProgress({ workOrder: wo, schedule, completed: [1] }).ready.slice(0, 2);
  const a = workOrderProgress({ workOrder: wo, schedule, completed: [1, ...done] });
  const b = workOrderProgress({ workOrder: wo, schedule, completed: [1, ...done] });
  assert.deepStrictEqual(JSON.stringify(a), JSON.stringify(b));
});

/* ---------------- 边界与校验 ---------------- */

test('现场进度：没有任何已分配刀次时完成率为 0，提交刀号报未知', () => {
  // 单批 3 张、容量 1 → 全部 over-capacity
  const sched = {
    stackLimit: 3,
    dependencies: [[], [], []],
    batches: [batchNode(1, [[1, 1], [2, 1], [3, 1]])],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10, maxSheetsPerBatch: 1 });
  const p = workOrderProgress({ workOrder: wo, schedule: sched });
  assert.strictEqual(p.cuts.length, 0);
  assert.strictEqual(p.summary.completionRate, 0);
  assert.strictEqual(p.summary.fullCompletionRate, 0);
  assert.strictEqual(p.summary.cutsUnassigned, 3);
  assert.throws(() => workOrderProgress({ workOrder: wo, schedule: sched, completed: [1] }), /未知全局刀号.*没有任何已分配/);
});

test('现场进度：缺少工单 / 工单记录非法时抛错', () => {
  assert.throws(() => workOrderProgress(), /现场进度输入/);
  assert.throws(() => workOrderProgress(null), /现场进度输入/);
  assert.throws(() => workOrderProgress({}), /工单结果/);
  assert.throws(() => workOrderProgress({ workOrder: {} }), /工单结果/);
  assert.throws(
    () => workOrderProgress({ workOrder: { shifts: [{ cuts: [{ cutNo: 1 }] }] } }),
    /成员/
  );
  const goodWo = workOrder({
    schedule: {
      stackLimit: 1,
      dependencies: [[]],
      batches: [batchNode(1, [[1, 1]])],
    },
    maxCutsPerShift: 5,
  });
  // 全局刀号重复
  assert.throws(() => workOrderProgress({
    workOrder: {
      shifts: [
        { shiftNo: 1, cuts: [{
          cutNo: 1, batchNo: 1, members: [{ sheetIndex: 1, cutNo: 1 }],
        }] },
        { shiftNo: 2, cuts: [{
          cutNo: 1, batchNo: 2, members: [{ sheetIndex: 2, cutNo: 1 }],
        }] },
      ],
      unassigned: [],
    },
  }), /全局刀号重复/);
  // 同一成员刀出现在两个刀次
  assert.throws(() => workOrderProgress({
    workOrder: {
      shifts: [{ shiftNo: 1, cuts: [
        { cutNo: 1, batchNo: 1, members: [{ sheetIndex: 1, cutNo: 1 }] },
        { cutNo: 2, batchNo: 2, members: [{ sheetIndex: 1, cutNo: 1 }] },
      ] }],
      unassigned: [],
    },
  }), /出现在多个已分配刀次/);
  // dependencies 非法
  assert.throws(() => workOrderProgress({
    workOrder: goodWo,
    schedule: { dependencies: 'x' },
  }), /dependencies/);
  assert.throws(() => workOrderProgress({
    workOrder: goodWo,
    schedule: { dependencies: [[[2]]] },
  }), /非法依赖记录/);
  // unassigned 非法
  assert.throws(() => workOrderProgress({
    workOrder: { shifts: goodWo.shifts, unassigned: 'bad' },
  }), /unassigned 必须是数组/);
});
