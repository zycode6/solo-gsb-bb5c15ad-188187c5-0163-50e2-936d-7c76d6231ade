'use strict';

/**
 * 裁切抽检计划（cut sampling inspection plan）
 *
 * 在执行工单（src/workorder.js 的 workOrder 结果）之上，为质量抽检挑选
 * **最多若干张纸**：每个**已分配全局刀次**都是抽检必须覆盖的目标，
 * 而一张纸被抽中时，它参与的**全部已分配刀次**都同时得到覆盖。
 *
 * 逐轮贪心选纸（确定性决胜）：
 *   1. 本轮选入后**新增覆盖的刀次数**最多；
 *   2. 新增数相同时，该纸参与的**已分配刀次总数**多者优先；
 *   3. 仍相同时，**纸张序号小**者优先。
 *
 * 达到抽检上限 maxSamples，或全部已分配刀次均已覆盖时停止。
 *
 * 未分配刀（工单 unassigned，over-capacity / missing-parent / blocked）**单列
 * 且不计入覆盖率分母**——它们不会被任何纸张的抽检覆盖，只作为现场提示原样返回。
 *
 * 工单与排程一致性（任一不符抛错 → HTTP 400）：
 *  - 成员引用缺失：工单刀次 / 未分配刀引用的“纸张#原刀号”不在排程任何批次内；
 *  - 重复归属：同一“纸张#原刀号”在排程多个批次、或在工单多个已分配刀次中出现；
 *  - schedule/workOrder 不一致：刀次缺来源批次、与排程批次成员不一致、
 *    未分配刀归属不明，或排程批次既未分配也未列入未分配。
 */

const MAX_SAMPLES = 500; // 抽检用纸上限与叠纸/批量用纸上限同一量级

const round4 = (v) => Math.round(v * 10000) / 10000;

const REASON_TEXT = {
  'over-capacity': '超每批容量',
  'missing-parent': '父刀缺失',
  blocked: '上游被阻断',
};

/**
 * 裁切抽检计划主入口。
 *
 * @param {object} input
 *   - workOrder：执行工单结果（必含 shifts，可含 unassigned/source）；
 *   - schedule：叠纸排程结果（必含 batches，用于成员归属一致性核对）；
 *   - maxSamples：抽检用纸上限（1～500 正整数，必填）。
 */
function samplingPlan(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('缺少抽检计划输入');
  }
  const wo = input.workOrder;
  if (!wo || typeof wo !== 'object' || !Array.isArray(wo.shifts)) {
    throw new Error('缺少工单结果（workOrder）——请先生成执行工单');
  }
  const schedule = input.schedule;
  if (!schedule || typeof schedule !== 'object' || !Array.isArray(schedule.batches)) {
    throw new Error('缺少排程结果（schedule）——抽检计划需要叠纸排程结果核对刀次归属');
  }
  if (schedule.batches.length === 0) {
    throw new Error('排程结果中没有任何刀次批次，无法生成抽检计划');
  }
  const n = Number(input.maxSamples);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('抽检用纸上限必须是正整数');
  }
  if (n > MAX_SAMPLES) {
    throw new Error(`抽检用纸上限不能超过 ${MAX_SAMPLES}`);
  }
  const maxSamples = n;

  /* ---------------- 排程批次：刀 → 批次（重复归属即不合法） ---------------- */

  const batchByNo = new Map(); // batchNo → { members:Set(token), order }
  const batchOfToken = new Map(); // token → batchNo
  schedule.batches.forEach((b, i) => {
    if (!b || typeof b !== 'object' || !Array.isArray(b.members) || b.members.length === 0) {
      throw new Error(`排程第 ${i + 1} 批缺少成员（members）`);
    }
    const batchNo = Number.isInteger(b.batchNo) && b.batchNo >= 1 ? b.batchNo : i + 1;
    if (batchByNo.has(batchNo)) {
      throw new Error(`排程批次号重复：${batchNo}`);
    }
    const members = new Set();
    b.members.forEach((m, j) => {
      if (!m
        || !(Number.isInteger(m.sheetIndex) && m.sheetIndex >= 1)
        || !(Number.isInteger(m.cutNo) && m.cutNo >= 1)) {
        throw new Error(`排程第 ${batchNo} 批第 ${j + 1} 个成员不是有效的 {sheetIndex, cutNo}`);
      }
      const token = `${m.sheetIndex}:${m.cutNo}`;
      if (members.has(token)) {
        throw new Error(`排程第 ${batchNo} 批内成员重复：第 ${m.sheetIndex} 张纸第 ${m.cutNo} 号刀`);
      }
      members.add(token);
      if (batchOfToken.has(token)) {
        throw new Error(
          `第 ${m.sheetIndex} 张纸第 ${m.cutNo} 号刀重复归属排程第 ${batchOfToken.get(token)} 批与第 ${batchNo} 批，排程结果不合法`
        );
      }
      batchOfToken.set(token, batchNo);
    });
    batchByNo.set(batchNo, { members, order: i });
  });

  /* ---------------- 工单已分配刀次 ---------------- */

  const cuts = [];
  const cutByNo = new Map(); // 全局刀号 → rec
  const cutOfToken = new Map(); // token → 全局刀号（可执行成员刀）
  const cutMembers = new Map(); // 全局刀号 → Set(token)（含未分配成员）
  const assignedBatchNoSeen = new Map(); // batchNo → 首个全局刀号

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
      if (!Number.isInteger(c.batchNo) || c.batchNo < 1) {
        throw new Error(`全局刀次 ${c.cutNo} 缺少来源批次（batchNo）`);
      }
      const batch = batchByNo.get(c.batchNo);
      if (!batch) {
        throw new Error(`全局刀次 ${c.cutNo} 的来源批次 ${c.batchNo} 不在排程结果中，schedule/workOrder 不一致`);
      }
      if (assignedBatchNoSeen.has(c.batchNo)) {
        throw new Error(
          `排程第 ${c.batchNo} 批同时出现在全局刀次 ${assignedBatchNoSeen.get(c.batchNo)} 与 ${c.cutNo} 中，schedule/workOrder 不一致`
        );
      }
      assignedBatchNoSeen.set(c.batchNo, c.cutNo);
      if (!Array.isArray(c.members) || c.members.length === 0) {
        throw new Error(`全局刀次 ${c.cutNo} 缺少成员（members）`);
      }
      const here = new Set();
      const memberRecs = c.members.map((m, j) => {
        if (!m
          || !(Number.isInteger(m.sheetIndex) && m.sheetIndex >= 1)
          || !(Number.isInteger(m.cutNo) && m.cutNo >= 1)) {
          throw new Error(`全局刀次 ${c.cutNo} 第 ${j + 1} 个成员不是有效的 {sheetIndex, cutNo}`);
        }
        const token = `${m.sheetIndex}:${m.cutNo}`;
        if (here.has(token)) {
          throw new Error(`全局刀次 ${c.cutNo} 内成员重复：第 ${m.sheetIndex} 张纸第 ${m.cutNo} 号刀`);
        }
        here.add(token);
        if (!batchOfToken.has(token)) {
          throw new Error(
            `全局刀次 ${c.cutNo} 引用的第 ${m.sheetIndex} 张纸第 ${m.cutNo} 号刀不在排程任何批次中，成员引用缺失`
          );
        }
        if (batchOfToken.get(token) !== c.batchNo) {
          throw new Error(
            `全局刀次 ${c.cutNo} 的成员第 ${m.sheetIndex} 张纸第 ${m.cutNo} 号刀在排程中归属第 ${batchOfToken.get(token)} 批而非第 ${c.batchNo} 批，schedule/workOrder 不一致`
          );
        }
        if (cutOfToken.has(token)) {
          throw new Error(
            `第 ${m.sheetIndex} 张纸第 ${m.cutNo} 号刀重复归属全局刀次 ${cutOfToken.get(token)} 与 ${c.cutNo}，工单记录不合法`
          );
        }
        return { token, sheetIndex: m.sheetIndex, cutNo: m.cutNo };
      });
      if (here.size !== batch.members.size || [...here].some((t) => !batch.members.has(t))) {
        throw new Error(
          `全局刀次 ${c.cutNo}（来源批次 ${c.batchNo}）的成员与排程批次不一致，schedule/workOrder 不一致`
        );
      }
      cutMembers.set(c.cutNo, here);
      const rec = {
        cutNo: c.cutNo,
        batchNo: c.batchNo,
        members: memberRecs,
      };
      cutByNo.set(c.cutNo, rec);
      cuts.push(rec);
    });
  });
  cuts.sort((a, b) => a.cutNo - b.cutNo);
  // 可执行成员刀先占位：未分配成员随后剔除（blocked 成员允许同时出现在 unassigned 中）
  cuts.forEach((rec) => rec.members.forEach((m) => cutOfToken.set(m.token, rec.cutNo)));

  /* ---------------- 工单未分配刀（单列、不计入分母） ---------------- */

  if (wo.unassigned !== undefined && !Array.isArray(wo.unassigned)) {
    throw new Error('工单 unassigned 必须是数组');
  }
  const unassignedTokens = new Set();
  const unassigned = (Array.isArray(wo.unassigned) ? wo.unassigned : []).map((u, i) => {
    if (!u
      || !(Number.isInteger(u.sheetIndex) && u.sheetIndex >= 1)
      || !(Number.isInteger(u.cutNo) && u.cutNo >= 1)) {
      throw new Error(`工单 unassigned 第 ${i + 1} 条不是有效的 {sheetIndex, cutNo} 记录`);
    }
    const token = `${u.sheetIndex}:${u.cutNo}`;
    if (unassignedTokens.has(token)) {
      throw new Error(`工单未分配刀重复登记：第 ${u.sheetIndex} 张纸第 ${u.cutNo} 号刀`);
    }
    const ownerBatch = batchOfToken.get(token);
    if (ownerBatch == null) {
      throw new Error(
        `未分配刀（第 ${u.sheetIndex} 张纸第 ${u.cutNo} 号刀）不在排程任何批次中，成员引用缺失`
      );
    }
    unassignedTokens.add(token);
    const reason = REASON_TEXT[u.reason] ? u.reason : 'blocked';
    return {
      sheetIndex: u.sheetIndex,
      cutNo: u.cutNo,
      reason,
      detail: typeof u.detail === 'string' && u.detail
        ? u.detail
        : `第 ${u.sheetIndex} 张纸第 ${u.cutNo} 号刀未分配到任何班次`,
      batchNo: Number.isInteger(u.batchNo) ? u.batchNo : ownerBatch,
    };
  });

  // blocked 成员刀同时出现在已分配刀次的 members 与 unassigned 中：它不是可执行成员
  unassignedTokens.forEach((token) => cutOfToken.delete(token));

  /* ---------------- 排程完整性：每个批次要么已分配、要么整批未分配 ---------------- */

  const assignedBatchNos = new Set(cuts.map((c) => c.batchNo));
  for (const batchNo of batchByNo.keys()) {
    if (assignedBatchNos.has(batchNo)) continue;
    // 未分配批次：其全部成员刀都应在 unassigned 中
    const missing = [...batchByNo.get(batchNo).members]
      .filter((token) => !unassignedTokens.has(token));
    if (missing.length) {
      const [si, cn] = missing[0].split(':').map(Number);
      throw new Error(
        `排程第 ${batchNo} 批既未分配到任何班次，也未列入未分配刀（如第 ${si} 张纸第 ${cn} 号刀），schedule/workOrder 不一致`
      );
    }
  }
  // 已分配批次的成员中，凡是“可执行成员”必须登记在 cutOfToken；blocked 成员则必须在 unassigned 中
  cuts.forEach((rec) => {
    rec.members.forEach((m) => {
      if (cutOfToken.get(m.token) === rec.cutNo) return; // 可执行成员
      if (!unassignedTokens.has(m.token)) {
        throw new Error(
          `全局刀次 ${rec.cutNo} 的成员第 ${m.sheetIndex} 张纸第 ${m.cutNo} 号刀既不可执行也未列入未分配，schedule/workOrder 不一致`
        );
      }
    });
  });

  /* ---------------- 纸张 → 参与的已分配刀次 ---------------- */

  const cutsOfSheet = new Map(); // sheetIndex → Set(全局刀号)（仅可执行成员刀）
  cutOfToken.forEach((cutNo, token) => {
    const si = Number(token.split(':')[0]);
    if (!cutsOfSheet.has(si)) cutsOfSheet.set(si, new Set());
    cutsOfSheet.get(si).add(cutNo);
  });
  const sheetIndexes = [...cutsOfSheet.keys()].sort((a, b) => a - b);

  /* ---------------- 逐轮贪心选纸 ---------------- */

  const targetTotal = cuts.length;
  const covered = new Set();
  const chosen = new Set();
  const rounds = [];
  let stopReason = null;

  while (chosen.size < maxSamples && covered.size < targetTotal) {
    // 候选：尚未抽中、且参与至少一个仍未覆盖刀次的纸张
    const candidates = sheetIndexes
      .filter((si) => !chosen.has(si))
      .map((si) => {
        const all = cutsOfSheet.get(si);
        let newCovered = 0;
        const uncoveredList = [];
        for (const cutNo of all) {
          if (!covered.has(cutNo)) {
            newCovered += 1;
            uncoveredList.push(cutNo);
          }
        }
        return {
          sheetIndex: si,
          totalCuts: all.size,
          newCovered,
          uncoveredCuts: uncoveredList.sort((a, b) => a - b),
        };
      })
      .filter((cand) => cand.newCovered > 0)
      .sort((a, b) =>
        (b.newCovered - a.newCovered)
        || (b.totalCuts - a.totalCuts)
        || (a.sheetIndex - b.sheetIndex));

    if (candidates.length === 0) {
      stopReason = 'covered'; // 理论上等价于 covered.size === targetTotal
      break;
    }

    const best = candidates[0];

    const tiedOnNew = candidates.filter((c) => c.newCovered === best.newCovered);
    const tiedOnTotal = tiedOnNew.filter((c) => c.totalCuts === best.totalCuts);

    const detail = [];
    detail.push(`新增覆盖 ${best.newCovered} 个未覆盖刀次，为全场最多`);
    if (tiedOnNew.length > 1) {
      detail.push(`与 ${tiedOnNew.length - 1} 张纸新增数并列，该纸参与已分配刀次共 ${best.totalCuts} 个（总数最多）`);
      if (tiedOnTotal.length > 1) {
        const others = tiedOnTotal
          .filter((c) => c.sheetIndex !== best.sheetIndex)
          .map((c) => `第 ${c.sheetIndex} 张`)
          .join('、');
        detail.push(`仍与${others}并列，纸张序号最小`);
      }
    }
    const note = `第 ${rounds.length + 1} 轮选中第 ${best.sheetIndex} 张纸：${detail.join('；')}`;

    chosen.add(best.sheetIndex);
    best.uncoveredCuts.forEach((cutNo) => covered.add(cutNo));

    rounds.push({
      round: rounds.length + 1,
      sheetIndex: best.sheetIndex,
      newCoveredCuts: best.newCovered,
      totalParticipatedCuts: best.totalCuts,
      coveredAfter: covered.size,
      candidatesConsidered: candidates.length,
      tieBreak: {
        maxNewCovered: best.newCovered,
        tiedOnNewCovered: tiedOnNew.length,
        maxTotalCuts: best.totalCuts,
        tiedOnTotalCuts: tiedOnTotal.length,
      },
      note,
    });
  }

  if (!stopReason) {
    stopReason = covered.size === targetTotal ? 'covered' : 'max-samples';
  }

  /* ---------------- 输出组装 ---------------- */

  const sheets = [...chosen].sort((a, b) => a - b).map((si) => {
    const cutNos = [...cutsOfSheet.get(si)].sort((a, b) => a - b);
    return {
      sheetIndex: si,
      cutCount: cutNos.length,
      cuts: cutNos.map((cutNo) => {
        const rec = cutByNo.get(cutNo);
        return {
          cutNo,
          batchNo: rec.batchNo,
          members: rec.members
            .filter((m) => !unassignedTokens.has(m.token))
            .map((m) => ({ sheetIndex: m.sheetIndex, cutNo: m.cutNo })),
        };
      }),
    };
  });

  const uncoveredCuts = targetTotal > 0
    ? cuts.filter((rec) => !covered.has(rec.cutNo)).map((rec) => ({
      cutNo: rec.cutNo,
      batchNo: rec.batchNo,
      members: rec.members
        .filter((m) => !unassignedTokens.has(m.token))
        .map((m) => ({ sheetIndex: m.sheetIndex, cutNo: m.cutNo })),
    }))
    : [];

  const coverageRate = targetTotal > 0 ? round4(covered.size / targetTotal) : 0;

  return {
    source: wo.source != null ? wo.source : (schedule.source != null ? schedule.source : null),
    maxSamples,
    stopReason,
    summary: {
      assignedCutsTotal: targetTotal,
      coveredCuts: covered.size,
      uncoveredCuts: uncoveredCuts.length,
      coverageRate,
      sheetsSelected: sheets.length,
      unassignedCuts: unassigned.length,
      roundsTotal: rounds.length,
    },
    rounds,
    sheets,
    uncoveredCuts,
    unassigned,
  };
}

module.exports = { samplingPlan, MAX_SAMPLES };
