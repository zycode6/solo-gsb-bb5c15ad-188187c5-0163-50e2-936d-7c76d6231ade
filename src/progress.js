'use strict';

/**
 * 现场进度（site progress）
 *
 * 在执行工单（src/workorder.js 的 workOrder 结果）之上，为车间现场提供
 * “哪些全局刀次现在就能切、哪些还在等父刀、整体完成到哪了”的实时视图。
 *
 * 合批刀次的父刀依赖按**成员纸张**汇总：一把已分配刀次（排程中的一个批次）
 * 含多张纸，每张纸各自切割树上的父刀都可能位于其他刀次——
 * **批内任一纸张的父刀尚未完成，整把合批刀次都不可就绪**。
 *
 * 父刀来源（与执行工单一致）：
 *  - schedule.dependencies（叠纸排程直供，按纸张排列的 [子刀号, 父刀号] 列表）；
 *  - 缺少 schedule 或 dependencies 时，按来源批次先后对同纸全部刀次
 *    （含未分配刀）推断成链（dependencySource: 'inferred'）。
 *
 * 父刀分两类：
 *  - waitingParents：父刀本身是已分配刀次 → 记录其全局刀号，完成即解锁；
 *  - blockers：父刀是未分配刀次（over-capacity / missing-parent / blocked）
 *    或不在排程中 → 持续阻塞，标明原因，现场永远无法通过勾选解除。
 *
 * 已完成全局刀号（completed）校验：
 *  - 必须为正整数且属于本工单已分配刀次（未知刀号 → 400）；
 *  - 未满足全部父刀（含未分配父刀）却先完成子刀 → 400，并逐条指出缺失父刀。
 */

const round4 = (v) => Math.round(v * 10000) / 10000;

const BLOCKER_TEXT = {
  'over-capacity': '超每批容量',
  'missing-parent': '父刀缺失',
  blocked: '上游被阻断',
};

/**
 * 现场进度主入口。
 *
 * @param {object} input
 *   - workOrder：执行工单结果（必含 shifts，可含 unassigned/source）；
 *   - schedule?：叠纸排程结果（取其 dependencies；缺省时若提供 sheets 则先排程）；
 *   - completed?：已完成全局刀号数组（正整数，缺省视为空）。
 */
function workOrderProgress(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('缺少现场进度输入');
  }
  const wo = input.workOrder;
  if (!wo || typeof wo !== 'object' || !Array.isArray(wo.shifts)) {
    throw new Error('缺少工单结果（workOrder）——请先生成执行工单');
  }

  /* ---------------- 已分配刀次 ---------------- */

  const cuts = [];
  const cutByNo = new Map(); // 全局刀号 → rec
  const assignedToken = new Map(); // "sheetIndex:cutNo" → 全局刀号（仅真正可执行的成员刀）

  // 未分配成员刀需要在解析工单刀次前已知，故先收集 unassigned
  if (wo.unassigned !== undefined && !Array.isArray(wo.unassigned)) {
    throw new Error('工单 unassigned 必须是数组');
  }
  const unassignedTokens = new Set();
  (Array.isArray(wo.unassigned) ? wo.unassigned : []).forEach((u) => {
    if (u && Number.isInteger(u.sheetIndex) && Number.isInteger(u.cutNo)) {
      unassignedTokens.add(`${u.sheetIndex}:${u.cutNo}`);
    }
  });

  wo.shifts.forEach((shift, shi) => {
    if (!shift || !Array.isArray(shift.cuts)) {
      throw new Error(`工单第 ${shi + 1} 班记录不合法（缺少 cuts）`);
    }
    shift.cuts.forEach((c) => {
      if (!c || !(Number.isInteger(c.cutNo) && c.cutNo >= 1)) {
        throw new Error('工单刀次记录缺少有效的全局刀号');
      }
      if (cutByNo.has(c.cutNo)) {
        throw new Error(`工单全局刀号重复：${c.cutNo}`);
      }
      if (!Array.isArray(c.members) || c.members.length === 0) {
        throw new Error(`全局刀次 ${c.cutNo} 缺少成员（members）`);
      }
      const members = c.members.map((m, j) => {
        if (!m
          || !(Number.isInteger(m.sheetIndex) && m.sheetIndex >= 1)
          || !(Number.isInteger(m.cutNo) && m.cutNo >= 1)) {
          throw new Error(`全局刀次 ${c.cutNo} 第 ${j + 1} 个成员不是有效的 {sheetIndex, cutNo}`);
        }
        return { sheetIndex: m.sheetIndex, cutNo: m.cutNo };
      });
      members.forEach((m) => {
        const token = `${m.sheetIndex}:${m.cutNo}`;
        if (unassignedTokens.has(token)) return; // 该成员刀已标记未分配，不是可执行成员
        if (assignedToken.has(token)) {
          throw new Error(`第 ${m.sheetIndex} 张纸第 ${m.cutNo} 号刀出现在多个已分配刀次中，工单记录不合法`);
        }
        assignedToken.set(token, c.cutNo);
      });
      cutByNo.set(c.cutNo, {
        cutNo: c.cutNo,
        shiftNo: Number.isInteger(shift.shiftNo) ? shift.shiftNo : null,
        cutInShift: Number.isInteger(c.cutInShift) ? c.cutInShift : null,
        batchNo: Number.isInteger(c.batchNo) ? c.batchNo : null,
        orient: c.orient === 'v' || c.orient === 'h' ? c.orient : null,
        kerf: c.kerf != null ? c.kerf : null,
        position: c.position != null ? c.position : null,
        region: c.region && typeof c.region === 'object'
          ? { w: c.region.w != null ? c.region.w : null, h: c.region.h != null ? c.region.h : null }
          : { w: null, h: null },
        cutLength: c.cutLength != null ? c.cutLength : null,
        sheetCount: members.length,
        members,
        waitingParents: [],
        blockers: [],
      });
    });
  });
  cutByNo.forEach((rec) => cuts.push(rec));
  cuts.sort((a, b) => a.cutNo - b.cutNo);

  /* ---------------- 未分配刀（持续阻塞来源） ---------------- */

  const unassignedByToken = new Map();
  (Array.isArray(wo.unassigned) ? wo.unassigned : []).forEach((u) => {
    if (u && Number.isInteger(u.sheetIndex) && Number.isInteger(u.cutNo)) {
      unassignedByToken.set(`${u.sheetIndex}:${u.cutNo}`, {
        sheetIndex: u.sheetIndex,
        cutNo: u.cutNo,
        reason: typeof u.reason === 'string' && BLOCKER_TEXT[u.reason] ? u.reason : 'blocked',
        detail: typeof u.detail === 'string' && u.detail
          ? u.detail
          : `第 ${u.sheetIndex} 张纸第 ${u.cutNo} 号刀未分配到任何班次`,
        batchNo: Number.isInteger(u.batchNo) ? u.batchNo : null,
      });
    }
  });

  /* ---------------- 父刀依赖对（按纸张） ---------------- */

  let schedule = input.schedule;
  if (!schedule || typeof schedule !== 'object') {
    // 与 workOrder 一致：只给 sheets 时先在服务端运行叠纸排程
    schedule = Array.isArray(input.sheets)
      // eslint-disable-next-line global-require
      ? require('./stack').stackSchedule(input)
      : null;
  }

  const pairsBySheet = new Map(); // sheetIndex → [[childCut, parentCut], ...]
  let dependencySource = 'inferred';

  if (schedule != null && schedule.dependencies !== undefined
    && !Array.isArray(schedule.dependencies)) {
    throw new Error('排程 dependencies 必须是按纸张排列的依赖数组');
  }

  if (schedule && Array.isArray(schedule.dependencies)) {
    dependencySource = 'dependencies';
    schedule.dependencies.forEach((list, i) => {
      const si = i + 1;
      if (!Array.isArray(list)) {
        throw new Error(`排程 dependencies 第 ${si} 张纸不是数组`);
      }
      list.forEach((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2
          || !(Number.isInteger(pair[0]) && pair[0] >= 1)
          || !(Number.isInteger(pair[1]) && pair[1] >= 1)) {
          throw new Error(`排程 dependencies 第 ${si} 张纸存在非法依赖记录`);
        }
        if (!pairsBySheet.has(si)) pairsBySheet.set(si, []);
        pairsBySheet.get(si).push([pair[0], pair[1]]);
      });
    });
  } else {
    // 推断：同一张纸上按来源批次先后（再按原刀号）把相邻刀连成链。
    // 未分配刀也在链中——已分配刀的链前驱若是未分配刀，即为持续阻塞项。
    const perSheet = new Map();
    // assigned: 该刀所在全局刀次；未分配刀以 Infinity 排序键附在已分配刀之后
    const remember = (sheetIndex, cutNo, batchNo, globalCutNo) => {
      if (!perSheet.has(sheetIndex)) perSheet.set(sheetIndex, []);
      perSheet.get(sheetIndex).push({
        cutNo,
        batchNo: Number.isInteger(batchNo) ? batchNo : Infinity,
        globalCutNo: globalCutNo == null ? Infinity : globalCutNo,
      });
    };
    cuts.forEach((rec) => rec.members.forEach((m) => remember(m.sheetIndex, m.cutNo, rec.batchNo, rec.cutNo)));
    unassignedByToken.forEach((u) => remember(u.sheetIndex, u.cutNo, u.batchNo, null));
    for (const [sheetIndex, list] of perSheet) {
      // 已分配刀（按来源批次 → 原刀号）在前，未分配刀附后（按来源批次 → 原刀号）
      list.sort((a, b) =>
        (a.globalCutNo === Infinity) - (b.globalCutNo === Infinity)
        || a.batchNo - b.batchNo
        || a.cutNo - b.cutNo);
      const pairs = [];
      for (let k = 1; k < list.length; k += 1) {
        pairs.push([list[k].cutNo, list[k - 1].cutNo]);
      }
      if (pairs.length) pairsBySheet.set(sheetIndex, pairs);
    }
  }

  /* ---------------- 汇总每把刀的全部成员父刀 ---------------- */

  cuts.forEach((rec) => {
    const waitingSeen = new Set();
    const blockerSeen = new Set();
    rec.members.forEach((m) => {
      (pairsBySheet.get(m.sheetIndex) || []).forEach(([childCut, parentCut]) => {
        if (childCut !== m.cutNo) return;
        const token = `${m.sheetIndex}:${parentCut}`;
        const parentGlobal = assignedToken.get(token);
        if (parentGlobal != null) {
          if (waitingSeen.has(token)) return;
          waitingSeen.add(token);
          rec.waitingParents.push({ sheetIndex: m.sheetIndex, cutNo: parentCut, globalCutNo: parentGlobal });
          return;
        }
        if (blockerSeen.has(token)) return;
        blockerSeen.add(token);
        const known = unassignedByToken.get(token);
        if (known) {
          rec.blockers.push({
            sheetIndex: known.sheetIndex, cutNo: known.cutNo,
            reason: known.reason, detail: known.detail, batchNo: known.batchNo,
          });
        } else {
          // 父刀既不在任何批次也不在未分配清单：该成员自身必为 missing-parent，
          // 其说明文字已指出缺失父刀；此处以成员说明兜底。
          const childEntry = unassignedByToken.get(`${m.sheetIndex}:${m.cutNo}`);
          rec.blockers.push({
            sheetIndex: m.sheetIndex, cutNo: parentCut,
            reason: 'missing-parent',
            detail: childEntry && childEntry.detail
              ? childEntry.detail
              : `第 ${m.sheetIndex} 张纸第 ${parentCut} 号父刀未出现在任何刀次中`,
            batchNo: null,
          });
        }
      });
    });
    rec.waitingParents.sort((a, b) =>
      (a.globalCutNo - b.globalCutNo) || (a.sheetIndex - b.sheetIndex) || (a.cutNo - b.cutNo));
    rec.blockers.sort((a, b) =>
      (a.sheetIndex - b.sheetIndex) || (a.cutNo - b.cutNo) || String(a.reason).localeCompare(String(b.reason)));
  });

  /* ---------------- 已完成刀号校验 ---------------- */

  let rawCompleted = input.completed;
  if (rawCompleted === undefined || rawCompleted === null) rawCompleted = [];
  if (!Array.isArray(rawCompleted)) {
    throw new Error('completed 必须是已完成全局刀号数组');
  }
  const completedSet = new Set();
  for (const v of rawCompleted) {
    if (typeof v === 'boolean' || !(Number.isInteger(v) && v >= 1)) {
      throw new Error(`已完成刀号必须是正整数：${String(v)}`);
    }
    if (!cutByNo.has(v)) {
      throw new Error(cuts.length
        ? `已完成记录含未知全局刀号：${v}（本工单共 ${cuts.length} 个已分配刀次，有效刀号 1～${cuts[cuts.length - 1].cutNo}）`
        : `已完成记录含未知全局刀号：${v}（本工单没有任何已分配刀次）`);
    }
    completedSet.add(v);
  }

  // 未满足父刀却先完成子刀：逐条指出缺失父刀（未分配父刀永远无法在现场补勾）
  const violations = [];
  cuts.forEach((rec) => {
    if (!completedSet.has(rec.cutNo)) return;
    const missing = rec.waitingParents.filter((p) => !completedSet.has(p.globalCutNo));
    if (missing.length || rec.blockers.length) {
      violations.push({ rec, missing });
    }
  });
  if (violations.length) {
    const parts = violations.slice(0, 3).map(({ rec, missing }) => {
      const need = [
        ...missing.map((p) =>
          `全局刀次 ${p.globalCutNo}（第 ${p.sheetIndex} 张纸第 ${p.cutNo} 号刀）`),
        ...rec.blockers.map((b) =>
          `第 ${b.sheetIndex} 张纸第 ${b.cutNo} 号刀（${BLOCKER_TEXT[b.reason] || b.reason}）`),
      ].join('、');
      return `全局刀次 ${rec.cutNo} 缺少前置父刀：${need}`;
    });
    const more = violations.length > parts.length ? `；另有 ${violations.length - parts.length} 处同类问题` : '';
    throw new Error(`存在父刀未完成却先完成的子刀——${parts.join('；')}${more}`);
  }

  /* ---------------- 状态判定 ---------------- */

  const ready = [];
  const blocked = [];
  cuts.forEach((rec) => {
    if (completedSet.has(rec.cutNo)) {
      rec.status = 'completed';
      return;
    }
    if (rec.blockers.length === 0
      && rec.waitingParents.every((p) => completedSet.has(p.globalCutNo))) {
      rec.status = 'ready';
      ready.push(rec.cutNo);
    } else {
      rec.status = 'blocked';
      blocked.push(rec.cutNo);
    }
  });

  /* ---------------- 班次 / 整单统计 ---------------- */

  const perShift = wo.shifts.map((shift) => {
    const total = Array.isArray(shift.cuts) ? shift.cuts.length : 0;
    const done = Array.isArray(shift.cuts)
      ? shift.cuts.filter((c) => c && completedSet.has(c.cutNo)).length
      : 0;
    return {
      shiftNo: Number.isInteger(shift.shiftNo) ? shift.shiftNo : null,
      cutsTotal: total,
      cutsCompleted: done,
      completionRate: total > 0 ? round4(done / total) : 0,
    };
  });

  const cutsAssigned = cuts.length;
  const cutsCompleted = completedSet.size;
  const unassignedCount = Number.isInteger(wo.summary && wo.summary.unassignedCuts)
    ? wo.summary.unassignedCuts
    : unassignedByToken.size;
  const reachableTotal = cutsAssigned + unassignedCount;

  const summary = {
    cutsAssigned,
    cutsCompleted,
    cutsReady: ready.length,
    cutsBlocked: blocked.length,
    cutsUnassigned: unassignedCount,
    // 已分配刀次完成率（现场勾选口径）
    completionRate: cutsAssigned > 0 ? round4(cutsCompleted / cutsAssigned) : 0,
    // 整单完成率：未分配刀计入分母，永远无法达到 100%
    fullCompletionRate: reachableTotal > 0 ? round4(cutsCompleted / reachableTotal) : 0,
    shiftsTotal: perShift.length,
    shiftsCompleted: perShift.filter((p) => p.cutsTotal > 0 && p.cutsCompleted === p.cutsTotal).length,
    perShift,
  };

  /* ---------------- 输出 ---------------- */

  return {
    source: wo.source != null
      ? wo.source
      : (schedule && schedule.source != null ? schedule.source : null),
    dependencySource,
    summary,
    completed: [...completedSet].sort((a, b) => a - b),
    ready,
    blocked,
    cuts: cuts.map((rec) => ({
      cutNo: rec.cutNo,
      shiftNo: rec.shiftNo,
      cutInShift: rec.cutInShift,
      batchNo: rec.batchNo,
      orient: rec.orient,
      kerf: rec.kerf,
      position: rec.position,
      region: rec.region,
      cutLength: rec.cutLength,
      sheetCount: rec.sheetCount,
      status: rec.status,
      members: rec.members.map((m) => ({ sheetIndex: m.sheetIndex, cutNo: m.cutNo })),
      waitingParents: rec.waitingParents.map((p) => ({ ...p })),
      blockers: rec.blockers.map((b) => ({ ...b })),
    })),
  };
}

module.exports = { workOrderProgress };
