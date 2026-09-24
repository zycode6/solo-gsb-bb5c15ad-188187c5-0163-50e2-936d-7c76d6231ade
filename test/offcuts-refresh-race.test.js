'use strict';

/*
 * 余料库存页：查询刷新协调（请求倒序覆盖）回归测试。
 *
 * 连续改动状态 / 尺寸 / 纹向 / 关键字会快速触发多次 ocRefresh，响应不保证
 * 按请求顺序返回。用假 DOM 与可控时序的 fetch 验证：
 *   1. 旧查询晚于新查询成功返回时，旧响应整体丢弃——汇总、明细、完整预占单、
 *      角标始终只反映最新一次查询；
 *   2. 过期的失败响应不得改写当前视图（新查询成功后仍显示新条件结果）；
 *   3. 当前有效（最新）查询失败时显示错误，并清空上一轮条件遗留的明细与
 *      预占单，避免按旧页面误判整单释放范围。
 */

const assert = require('node:assert');
const { test } = require('node:test');

/* ---------------- 假 DOM / fetch 装配（须在 require offcuts.js 之前） ---------------- */

function makeEl() {
  return {
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    className: '',
    innerHTML: '',
    classList: { toggle() {} },
    addEventListener() {},
    querySelectorAll() { return []; },
  };
}

const els = new Map();
global.document = {
  getElementById(id) {
    if (!els.has(id)) els.set(id, makeEl());
    return els.get(id);
  },
  // 无选中的状态单选框 → 不带 status 参数，各次请求以 q=关键字 区分
  querySelector() { return null; },
  querySelectorAll() { return []; },
};
global.window = {};

// fetch 路由：初始角标请求走默认 JSON；每个测试安装自己的挂起队列。
let activeFetch = async (url) => {
  if (url === '/api/offcuts') {
    return { ok: true, json: async () => ({ summary: { total: 0 } }) };
  }
  throw new Error('未安装测试 fetch 处理器');
};
global.fetch = (url, opts) => activeFetch(url, opts);

const { ocRefresh } = require('../public/offcuts');

const el = (id) => global.document.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 0));
const jsonResp = (body, ok = true) => ({ ok, json: async () => body });

function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
}

// 安装挂起队列：每个 /api/offcuts?... 查询按发起顺序入队，何时返回由测试控制
function installPendingFetch() {
  const pending = [];
  activeFetch = (url) => {
    if (!url.includes('?')) {
      return Promise.resolve(jsonResp({ summary: { total: 0 } }));
    }
    const d = deferred();
    pending.push({ url, ...d });
    return d.promise;
  };
  return pending;
}

/* ---------------- 测试数据 ---------------- */

const availOffcut = (id) => ({
  id,
  paperName: '纸型',
  w: 10, h: 10, area: 100,
  paperWidth: 100, paperHeight: 100,
  paperGrain: 'along-width', kerf: 1, x: 0, y: 0,
  source: {},
  status: 'available',
});

const reservedChip = (id, allocationId) => ({
  id,
  w: 8, h: 8,
  source: {},
  reservation: { allocationId, rotated: false },
});

const group = (allocationId, tag) => ({
  allocationId,
  product: { width: 5, height: 5, grain: 'any' },
  ref: null,
  createdAt: new Date(`2026-01-0${tag}T00:00:00Z`).toISOString(),
  count: 1,
  offcuts: [reservedChip(`OC-${allocationId}-R`, allocationId)],
});

const dataset = (tag, totalArea, badgeTotal) => ({
  summary: {
    total: badgeTotal, available: 1, reserved: 1,
    availableArea: 100, reservedArea: 100, totalArea,
  },
  offcuts: [availOffcut(`OC-${tag}`)],
  allocationGroups: [group(`ALLOC-${tag}`, tag === '新' ? 2 : 1)],
});

const OLD_DATA = dataset('旧', 111, 1);
const NEW_DATA = dataset('新', 222, 2);

function assertView(tag, area, badgeTotal) {
  const listHtml = el('ocListWrap').innerHTML;
  const allocHtml = el('ocAllocations').innerHTML;
  assert.ok(listHtml.includes(`OC-${tag}`), `明细应显示 ${tag} 条件的结果`);
  assert.ok(!listHtml.includes(`OC-${tag === '新' ? '旧' : '新'}`), '明细不得残留另一条件的结果');
  assert.ok(allocHtml.includes(`ALLOC-${tag}`), `预占单应显示 ${tag} 条件同次返回的完整分组`);
  assert.ok(!allocHtml.includes(`ALLOC-${tag === '新' ? '旧' : '新'}`), '预占单不得被另一条件覆盖');
  assert.ok(el('ocSummary').innerHTML.includes(String(area)), '汇总应与最新查询一致');
  assert.equal(el('navOffcutBadge').textContent, badgeTotal, '角标应与最新查询一致');
}

test('旧查询晚成功返回时被整体丢弃，最新查询统一更新四块视图', async () => {
  const pending = installPendingFetch();

  el('qKw').value = '旧';
  const pOld = ocRefresh();
  el('qKw').value = '新';
  const pNew = ocRefresh();
  assert.equal(pending.length, 2);

  // “新”先返回并渲染
  pending[1].resolve(jsonResp(NEW_DATA));
  await pNew;
  await tick();
  assertView('新', 222, 2);

  // “旧”后返回：过期成功响应不得倒序覆盖
  pending[0].resolve(jsonResp(OLD_DATA));
  await pOld;
  await tick();
  assertView('新', 222, 2);
});

test('旧查询失败且晚处理时，过期错误不得改写新条件视图', async () => {
  const pending = installPendingFetch();

  el('qKw').value = '旧';
  const pOld = ocRefresh();
  el('qKw').value = '新';
  const pNew = ocRefresh();

  // 新查询先成功并渲染；旧查询的失败响应晚到（过期失败）
  pending[1].resolve(jsonResp(NEW_DATA));
  await pNew;
  await tick();
  assertView('新', 222, 2);

  pending[0].resolve(jsonResp({ error: '旧条件服务器错误' }, false));
  await pOld;
  await tick();

  const listHtml = el('ocListWrap').innerHTML;
  assert.ok(!listHtml.includes('旧条件服务器错误'), '过期失败响应不得报错到当前视图');
  assert.ok(!listHtml.includes('form-error'), '当前视图不应出现错误条');
  assertView('新', 222, 2);
});

test('当前有效查询失败时显示错误并清空过期明细与预占单', async () => {
  const pending = installPendingFetch();

  // 先有一次成功查询，页面展示旧条件数据
  el('qKw').value = '旧';
  const pBase = ocRefresh();
  pending[0].resolve(jsonResp(OLD_DATA));
  await pBase;
  await tick();
  assertView('旧', 111, 1);

  // 改为“新”后最新查询失败
  el('qKw').value = '新';
  const pFail = ocRefresh();
  pending[1].resolve(jsonResp({ error: '当前查询失败' }, false));
  await pFail;
  await tick();

  const listHtml = el('ocListWrap').innerHTML;
  assert.ok(listHtml.includes('form-error') && listHtml.includes('当前查询失败'),
    '最新查询失败应显示错误');
  assert.ok(!listHtml.includes('OC-旧'), '旧明细必须随当前失败一并清除');
  assert.equal(el('ocAllocations').innerHTML, '', '旧预占单必须清空，防止误判整单释放范围');
  // 汇总与角标为全库口径，失败路径不重写为错误状态
  assert.ok(el('ocSummary').innerHTML.includes('111'));
  assert.equal(el('navOffcutBadge').textContent, 1);
});
