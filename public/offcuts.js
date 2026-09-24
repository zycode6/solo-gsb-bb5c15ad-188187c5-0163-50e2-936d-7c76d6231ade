'use strict';

/*
 * 余料库存与复用预占页面（独立脚本，通过全局 layoutLatestResult
 * 与 app.js 共享最近一次裁切试排 / 排产 / 比选结果）。
 *
 * 安全：纸型名、订单号、批次号、单据号等均为用户录入的动态值，会进入
 * 列表、预占明细与复用结果。所有拼入 innerHTML 的动态值必须按上下文经
 * escape.js 的 ocEscapeHtml（文本）/ ocEscapeAttr（属性）转义，
 * 避免存储型脚本注入。
 */

// 浏览器中由先加载的 escape.js 挂到 window；Node 测试环境走 require。
const ocEsc = (typeof module !== 'undefined' && module.exports)
  ? require('./escape')
  : window;
const ocEscapeHtml = ocEsc.ocEscapeHtml;
const ocEscapeAttr = ocEsc.ocEscapeAttr;

const OC$ = (id) => document.getElementById(id);

const OC_GRAIN_PAPER = {
  'along-width': '沿宽 ↔',
  'along-height': '沿高 ↕',
};
const OC_GRAIN_REQ = {
  any: '不限',
  'along-width': '沿自身宽',
  'along-height': '沿自身高',
};

const ocFmt = (n) => (Math.round(n * 100) / 100).toLocaleString('zh-CN');
const ocMoneyArea = (n) => (n == null ? '—' : ocFmt(n));

async function ocApi(path, options = {}) {
  const resp = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || '请求失败');
  return data;
}

function ocShowError(id, msg) {
  const box = OC$(id);
  if (!msg) { box.hidden = true; box.textContent = ''; return; }
  box.textContent = msg;
  box.hidden = false;
}

/* ---------------- 视图切换 ---------------- */

function ocShowView(name) {
  const layout = OC$('viewLayout');
  const offcuts = OC$('viewOffcuts');
  layout.hidden = name !== 'layout';
  offcuts.hidden = name !== 'offcuts';
  OC$('navLayout').classList.toggle('active', name === 'layout');
  OC$('navOffcuts').classList.toggle('active', name === 'offcuts');
  if (name === 'offcuts') ocRefresh();
}

/* ---------------- 当前排料结果登记 ---------------- */

async function ocIngestCurrent() {
  const btn = OC$('ingestBtn');
  const result = window.layoutLatestResult;
  if (!result) {
    ocShowError('ingestMsg', '当前没有可登记的排料结果，请先生成裁切 / 排产方案。');
    return;
  }
  const batchId = OC$('ingestBatchId').value.trim();
  btn.disabled = true;
  ocShowError('ingestMsg', '');
  try {
    const data = await ocApi('/api/offcuts/ingest', {
      method: 'POST',
      body: { layout: result, ...(batchId ? { batchId } : {}) },
    });
    const shapeLabel = {
      single: '单张 / 比选', batch: '批量排产', cost: '多纸型成本',
    }[data.shape] || data.shape;
    ocShowError('ingestMsg', '');
    const box = OC$('ingestMsg');
    box.className = 'form-ok';
    box.textContent = `✔ 已从${shapeLabel}结果登记 ${data.ingested} 块余料（批次 ${data.batchId}）`
      + `${data.skipped ? `，跳过 ${data.skipped} 块同批次重复余料` : ''}。`
      + '可切换至「余料库存与复用」查看。';
    box.hidden = false;
    ocUpdateNavBadge(data.summary);
  } catch (e) {
    ocShowError('ingestMsg', e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 手工录入 ---------------- */

async function ocCreate() {
  const width = Number(OC$('ocW').value);
  const height = Number(OC$('ocH').value);
  if (!(width > 0) || !(height > 0)) {
    ocShowError('ocCreateMsg', '余料宽高必须为正数。');
    return;
  }
  const kerf = Number(OC$('ocKerf').value);
  if (!(kerf >= 0)) {
    ocShowError('ocCreateMsg', '刀缝宽度必须是非负数。');
    return;
  }
  const body = {
    paperName: OC$('ocName').value.trim(),
    width, height,
    paperGrain: OC$('ocGrain').value,
    kerf,
    orderNo: OC$('ocOrderNo').value.trim() || undefined,
    batchId: OC$('ocBatchId').value.trim() || undefined,
  };
  OC$('ocCreate').disabled = true;
  try {
    const data = await ocApi('/api/offcuts', { method: 'POST', body });
    const box = OC$('ocCreateMsg');
    box.className = 'form-ok';
    box.textContent = `✔ 已录入余料 ${data.offcut.id}（${ocFmt(width)}×${ocFmt(height)} mm）。`;
    box.hidden = false;
    ['ocW', 'ocH', 'ocOrderNo'].forEach((id) => { OC$(id).value = ''; });
    ocUpdateNavBadge(data.summary);
  } catch (e) {
    ocShowError('ocCreateMsg', e.message);
  } finally {
    OC$('ocCreate').disabled = false;
  }
}

/* ---------------- 查询 / 列表 ---------------- */

// 查询刷新代次：状态 / 尺寸 / 纹向 / 关键字连续变化会快速触发多次查询，
// 响应可能不按请求顺序返回。每次刷新递增并记录自己的代次，await 返回后
// 只有仍是最新的一次查询允许写视图；过期响应（无论成功还是失败）一律丢弃，
// 杜绝“新条件先返回、旧条件后返回”导致的倒序覆盖。
let ocRefreshSeq = 0;

async function ocRefresh() {
  const params = new URLSearchParams();
  const status = document.querySelector('input[name="ocStatus"]:checked');
  if (status && status.value !== 'all') params.set('status', status.value);
  const minW = OC$('qMinW').value;
  const minH = OC$('qMinH').value;
  if (minW) params.set('minW', minW);
  if (minH) params.set('minH', minH);
  const grain = OC$('qGrain').value;
  if (grain) params.set('grain', grain);
  const kw = OC$('qKw').value.trim();
  if (kw) params.set('q', kw);

  const seq = ++ocRefreshSeq;
  let data;
  try {
    data = await ocApi(`/api/offcuts?${params.toString()}`);
  } catch (e) {
    // 过期失败响应不得触碰视图（当前视图属于更新的那次查询）；
    // 仅最新一次查询失败时，报错并清除上一轮条件遗留的明细与完整预占单，
    // 避免用户按旧页面误判整单释放范围（释放按钮始终对应整单）。
    if (seq !== ocRefreshSeq) return;
    OC$('ocListWrap').innerHTML = `<div class="form-error">${ocEscapeHtml(e.message)}</div>`;
    OC$('ocAllocations').innerHTML = '';
    return;
  }
  // 过期成功响应同样整体丢弃：汇总、明细、完整预占单、角标只由最新一次
  // 查询统一更新，四者始终属于同一筛选条件，不允许半截覆盖。
  if (seq !== ocRefreshSeq) return;
  ocRenderSummary(data.summary);
  ocRenderList(data.offcuts);
  // 明细遵循筛选条件；预占单分组使用服务端同次读取返回的完整分组，
  // 不随筛选裁剪（组内编号、总块数与释放按钮始终对应整单）
  ocRenderAllocations(data.allocationGroups, data.offcuts);
  ocUpdateNavBadge(data.summary);
}

function ocRenderSummary(s) {
  OC$('ocSummary').innerHTML = `
    <div class="stat">库存总数：<b>${s.total}</b> 块</div>
    <div class="stat">可用：<b class="oc-num-avail">${s.available}</b> 块 / ${ocFmt(s.availableArea)} mm²</div>
    <div class="stat">已预占：<b class="oc-num-reserved">${s.reserved}</b> 块 / ${ocFmt(s.reservedArea)} mm²</div>
    <div class="stat">库存总面积：<b>${ocFmt(s.totalArea)}</b> mm²</div>
  `;
}

function ocSourceText(o) {
  const src = o.source || {};
  // src.type 为枚举值（single/batch/cost/manual），未识别时原样转义输出；
  // sheetIndex/round 已由服务端转为数字。批次号为用户录入，必须转义。
  const typeLabelRaw = {
    single: '单张/比选', batch: '批量', cost: '多纸型', manual: '手工',
  }[src.type] || (src.type == null ? '' : src.type);
  const typeLabel = typeLabelRaw || '—';
  const sheet = src.sheetIndex ? ` · 第${src.sheetIndex}张` : '';
  const round = src.round ? ` · 轮次${src.round}` : '';
  return `${ocEscapeHtml(typeLabel)}${sheet}${round} · 批次 ${ocEscapeHtml(src.batchId || '—')}`;
}

function ocGrainPaperLabel(grain) {
  return OC_GRAIN_PAPER[grain] || (grain == null ? grain : ocEscapeHtml(grain));
}

function ocGrainReqLabel(grain) {
  return OC_GRAIN_REQ[grain] || (grain == null ? grain : ocEscapeHtml(grain));
}

function ocOffcutRowHtml(o) {
  const reserved = o.status === 'reserved';
  const r = o.reservation || null;
  // 余料编号、纸型名、批次/订单号、单据号均为服务端回传的动态值，统一转义
  return `
      <tr class="${reserved ? 'oc-row-reserved' : 'oc-row-available'}">
        <td><b>${ocEscapeHtml(o.id)}</b></td>
        <td>${o.paperName ? ocEscapeHtml(o.paperName) : '<span class="ord-null">未命名</span>'}</td>
        <td class="num">${ocFmt(o.w)}×${ocFmt(o.h)}</td>
        <td class="num">${ocFmt(o.area)}</td>
        <td class="num">${ocFmt(o.paperWidth)}×${ocFmt(o.paperHeight)}</td>
        <td>${ocGrainPaperLabel(o.paperGrain)}</td>
        <td class="num">${ocFmt(o.kerf)}</td>
        <td class="num">(${ocFmt(o.x)}, ${ocFmt(o.y)})</td>
        <td class="oc-source">${ocSourceText(o)}${o.source.orderNo ? ` · 订单 ${ocEscapeHtml(o.source.orderNo)}` : ''}</td>
        <td>${reserved
          ? `<span class="oc-status oc-status-reserved">已预占</span>
             <div class="oc-res-info">单号 <b>${ocEscapeHtml(r.allocationId)}</b><br />
               成品 ${ocFmt(r.product.width)}×${ocFmt(r.product.height)}
               （${ocGrainReqLabel(r.product.grain)}${r.rotated ? ' · 旋转90°' : ''}）
               ${r.ref ? `<br />单据 ${ocEscapeHtml(r.ref)}` : ''}</div>`
          : '<span class="oc-status oc-status-available">可用</span>'}</td>
      </tr>`;
}

function ocListHtml(list) {
  if (!list.length) {
    return '<div class="placeholder">没有符合条件的余料。可在「裁切试排」页把排料结果的余料登记入库，或在左侧手工录入。</div>';
  }
  const rows = list.map(ocOffcutRowHtml).join('');
  return `
    <table class="oc-table">
      <thead><tr>
        <th>余料编号</th><th>纸型</th><th class="num">余料 宽×高 (mm)</th>
        <th class="num">面积 (mm²)</th><th class="num">来源纸面 宽×高</th>
        <th>纸张纹向</th><th class="num">刀缝 (mm)</th><th class="num">纸面坐标</th>
        <th>来源（类型 / 张次 / 批次 / 订单）</th><th>状态 / 预占信息</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function ocRenderList(list) {
  OC$('ocListWrap').innerHTML = ocListHtml(list);
}

/* ---------------- 预占单分组与释放 ---------------- */

/**
 * 渲染已预占单分组。
 * @param {Array} groups 服务端按整单汇总的完整预占单分组（allocationGroups），
 *   不经列表筛选裁剪：组内编号、总块数与「释放该预占」始终对应整单。
 * @param {Array} [visibleList] 当前筛选命中的明细；用于标注组内哪些余料
 *   不在明细列表中（被筛选条件排除），避免“列表只见一块、整单却有两块”的误读。
 *
 * 旧调用形态 ocAllocationsHtml(offcuts)（Node 回归测试 / 旧数据）仍兼容：
 * 传入的若是余料数组，则先按预占单现场分组。
 */
function ocAllocationsHtml(groups, visibleList) {
  let normalized = groups;
  if (!Array.isArray(groups)) {
    normalized = [];
  } else if (groups.length && groups[0] && groups[0].status !== undefined) {
    // 兼容旧入参：余料明细数组 → 现场分组（无法补出被筛选掉的成员）
    const byAlloc = new Map();
    for (const o of groups) {
      if (o.status !== 'reserved') continue;
      const aid = o.reservation.allocationId;
      if (!byAlloc.has(aid)) byAlloc.set(aid, []);
      byAlloc.get(aid).push(o);
    }
    normalized = [...byAlloc.entries()].map(([allocationId, offcuts]) => ({
      allocationId,
      product: offcuts[0].reservation.product,
      ref: offcuts[0].reservation.ref,
      createdAt: offcuts[0].reservation.createdAt,
      count: offcuts.length,
      offcuts,
    }));
  }

  if (!normalized.length) return '';

  // 当前筛选命中的余料编号；缺省（旧调用）视为组内成员全部可见
  const visibleIds = visibleList
    ? new Set(visibleList.map((o) => o.id))
    : null;

  const blocks = normalized.map((g) => {
    const chips = g.offcuts.map((o) => {
      const out = visibleIds ? visibleIds.has(o.id) : true;
      // 被筛选排除的成员仅作视觉弱化并在 title 中说明，仍属于整单、仍会被整单释放
      const suffix = out ? '' : '（不在当前筛选结果中，整单释放时一并释放）';
      return `
      <span class="oc-chip${out ? '' : ' oc-chip-muted'}" title="${ocSourceText(o)}${ocEscapeAttr(suffix)}">
        ${ocEscapeHtml(o.id)} · ${ocFmt(o.w)}×${ocFmt(o.h)}${o.reservation.rotated ? ' ⟳' : ''}
      </span>`;
    }).join('');
    const hiddenCount = visibleIds
      ? g.offcuts.filter((o) => !visibleIds.has(o.id)).length
      : 0;
    const hiddenNote = hiddenCount
      ? `<span class="oc-alloc-filtered">另有 <b>${hiddenCount}</b> 块不在当前筛选结果中，整单共 <b>${g.count}</b> 块；释放按整单全部释放</span>`
      : '';
    return `
      <div class="oc-alloc-group">
        <div class="oc-alloc-head">
          <span>预占单 <b>${ocEscapeHtml(g.allocationId)}</b></span>
          <span>成品 <b>${ocFmt(g.product.width)}×${ocFmt(g.product.height)}</b> mm
            （${ocGrainReqLabel(g.product.grain)}）</span>
          <span>占用 <b>${g.count}</b> 块</span>
          ${hiddenNote}
          ${g.ref ? `<span>单据：<b>${ocEscapeHtml(g.ref)}</b></span>` : ''}
          <span class="oc-alloc-time">${ocEscapeHtml(new Date(g.createdAt).toLocaleString('zh-CN'))}</span>
          <button type="button" class="btn btn-ghost oc-release" data-allocation="${ocEscapeAttr(g.allocationId)}">释放该预占</button>
        </div>
        <div class="oc-chips">${chips}</div>
      </div>`;
  }).join('');
  return `<h3>已预占余料（按预占单分组，整单释放）</h3>${blocks}`;
}

function ocRenderAllocations(groups, visibleList) {
  const box = OC$('ocAllocations');
  box.innerHTML = ocAllocationsHtml(groups, visibleList);
  box.querySelectorAll('.oc-release').forEach((btn) =>
    btn.addEventListener('click', () => ocRelease({ allocationIds: [btn.dataset.allocation] })));
}

async function ocRelease(body) {
  try {
    await ocApi('/api/offcuts/release', { method: 'POST', body });
    await ocRefresh();
  } catch (e) {
    window.alert(e.message);
  }
}

/* ---------------- 复用预占 ---------------- */

async function ocAllocate() {
  const width = Number(OC$('alW').value);
  const height = Number(OC$('alH').value);
  const quantity = Number(OC$('alQty').value);
  if (!(width > 0) || !(height > 0)) {
    ocShowError('alMsg', '成品宽高必须为正数。');
    return;
  }
  if (!(Number.isInteger(quantity) && quantity >= 1)) {
    ocShowError('alMsg', '预占数量必须是正整数。');
    return;
  }
  const payload = {
    width, height, quantity,
    grain: OC$('alGrain').value,
    ref: OC$('alRef').value.trim() || undefined,
  };
  OC$('alCreate').disabled = true;
  ocShowError('alMsg', '');
  try {
    const data = await ocApi('/api/offcuts/allocate', { method: 'POST', body: payload });
    ocShowAllocationResult(data);
    ocUpdateNavBadge(data.summary);
    if (data.allocated) await ocRefresh();
  } catch (e) {
    ocShowError('alMsg', e.message);
  } finally {
    OC$('alCreate').disabled = false;
  }
}

function ocAllocationResultHtml(data) {
  if (data.allocated) {
    return `✔ 已原子预占 <b>${data.reservedCount}</b> 块余料，预占单号
      <b>${ocEscapeHtml(data.allocationId)}</b>${data.request.ref ? `（单据 ${ocEscapeHtml(data.request.ref)}）` : ''}；
      可行候选共 ${data.feasibleCount} 块。`;
  }
  const cand = data.candidates.length
    ? `当前可行余料仅 <b>${data.feasibleCount}</b> 块：${data.candidates
      .map((c) => `${ocEscapeHtml(c.paperName || c.offcutId)}（${ocFmt(c.width)}×${ocFmt(c.height)}${c.rotated ? '·旋转' : ''}）`)
      .join('、')}。`
    : '当前没有任何可行余料。';
  return `⚠ 库存不足：需求 <b>${data.request.quantity}</b> 块，可行仅
      <b>${data.feasibleCount}</b> 块，<b>缺口 ${data.shortfall} 块</b>。
      未扣减任何已占用记录。${cand}<br />
      受阻统计：尺寸不足 ${data.blockedBySize} 块、纹向受限 ${data.blockedByGrain} 块、
      已被预占 ${data.unavailableReserved} 块。`;
}

function ocShowAllocationResult(data) {
  const box = OC$('alMsg');
  box.className = data.allocated ? 'form-ok' : 'form-error';
  box.innerHTML = ocAllocationResultHtml(data);
  box.hidden = false;
}

/* ---------------- 导航角标 ---------------- */

function ocUpdateNavBadge(summary) {
  if (!summary) return;
  const badge = OC$('navOffcutBadge');
  if (summary.total > 0) {
    badge.textContent = summary.total;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

/* ---------------- 事件绑定（仅浏览器环境） ---------------- */

if (typeof document !== 'undefined') {
  OC$('navLayout').addEventListener('click', () => ocShowView('layout'));
  OC$('navOffcuts').addEventListener('click', () => ocShowView('offcuts'));
  OC$('ingestBtn').addEventListener('click', ocIngestCurrent);
  OC$('ocCreate').addEventListener('click', ocCreate);
  OC$('alCreate').addEventListener('click', ocAllocate);
  OC$('ocRefresh').addEventListener('click', ocRefresh);
  document.querySelectorAll('input[name="ocStatus"]').forEach((r) =>
    r.addEventListener('change', ocRefresh));
  ['qMinW', 'qMinH'].forEach((id) =>
    OC$(id).addEventListener('change', ocRefresh));
  OC$('qGrain').addEventListener('change', ocRefresh);
  let ocKwTimer = null;
  OC$('qKw').addEventListener('input', () => {
    clearTimeout(ocKwTimer);
    ocKwTimer = setTimeout(ocRefresh, 300);
  });

  window.ocRefreshOffcuts = ocRefresh;

  // 页面初始加载库存角标（服务重启后库存为空则不显示）
  (async function initBadge() {
    try {
      const data = await ocApi('/api/offcuts');
      ocUpdateNavBadge(data.summary);
    } catch (_) { /* 服务暂不可用时静默 */ }
  })();
}

// 纯字符串构造函数在 Node 测试中导出（回归校验动态值渲染转义）；
// ocRefresh 一并导出，供查询刷新协调（请求倒序覆盖）回归测试使用。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ocListHtml,
    ocAllocationsHtml,
    ocAllocationResultHtml,
    ocSourceText,
    ocRefresh,
  };
}
