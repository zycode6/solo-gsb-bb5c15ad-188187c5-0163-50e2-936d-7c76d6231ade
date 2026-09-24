'use strict';

/*
 * 余料库存与复用页：存储型脚本注入回归测试。
 *
 * 手工录入 / 排料结果登记的纸型名、订单号、批次号、单据号等动态值会进入
 * 列表（ocListHtml）、预占明细（ocAllocationsHtml）与复用结果
 * （ocAllocationResultHtml）。这里以含标签与事件属性的载荷构造服务端
 * 返回形态，断言渲染出的 HTML：
 *   1. 不出现任何白名单之外的标签 / 属性（无法构造脚本节点或事件属性）；
 *   2. 原始载荷只以实体编码形式出现（< 不会开启新标签）；
 *   3. 解码后仍能看到原文，且正常中文与符号（× ↔ · 等）保持显示。
 */

const assert = require('node:assert');
const { test } = require('node:test');
const { ocEscapeHtml, ocEscapeAttr } = require('../public/escape');
const {
  ocListHtml,
  ocAllocationsHtml,
  ocAllocationResultHtml,
  ocSourceText,
} = require('../public/offcuts');

// 典型存储型 XSS 载荷：脚本标签、<img> 事件属性、属性逃逸、SVG、javascript: 等
const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  '"><b onclick="alert(1)">点我</b>',
  "' onmouseover='alert(1)",
  '<a href="javascript:alert(1)">链接</a>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '中文×↔↕·引号"撇号\'&符号',
];
const NAME = PAYLOADS[0];
const ORDER = PAYLOADS[1];
const BATCH = PAYLOADS[3];
const REF = PAYLOADS[4];
const AID = PAYLOADS[2];
const GRAIN_PAYLOAD = PAYLOADS[5];

/* ---------------- 转义函数单测 ---------------- */

test('ocEscapeHtml / ocEscapeAttr：危险字符全部实体化，中文与符号保留', () => {
  for (const p of PAYLOADS) {
    const out = ocEscapeHtml(p);
    // 任何 < 都不能以原文出现，杜绝新标签；引号实体化后无法逃逸属性
    assert.ok(!out.includes('<'), `文本转义不应保留 < ：${out}`);
    assert.ok(!out.includes('>'), `文本转义不应保留 > ：${out}`);
    assert.ok(!out.includes('"'), `文本转义不应保留裸引号：${out}`);
    assert.ok(!out.includes("'"), `文本转义不应保留裸撇号：${out}`);
    assert.equal(ocEscapeAttr(p), out);
  }
  assert.equal(ocEscapeHtml(null), '');
  assert.equal(ocEscapeHtml(undefined), '');
  // & 必须最先转义，避免二次破坏实体
  assert.equal(ocEscapeHtml('A&B<C>"D\'E'), 'A&amp;B&lt;C&gt;&quot;D&#39;E');
  // 非字符串安全转换
  assert.equal(ocEscapeHtml(123), '123');
});

/* ---------------- HTML 结构白名单校验 ---------------- */

// 渲染模板中唯一允许出现的标签（静态结构）。
const ALLOWED_TAGS = new Set([
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'b', 'span', 'div', 'br', 'h3', 'button',
]);
// 渲染模板中唯一允许出现的属性（静态结构）。事件属性 / id / src / href 均不在其中。
const ALLOWED_ATTRS = new Set(['class', 'title', 'type', 'data-allocation']);

function assertSafeStaticStructure(html, where) {
  const tags = [...html.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?\/?>/g)]
    .map((m) => m[1].toLowerCase());
  for (const t of tags) {
    assert.ok(ALLOWED_TAGS.has(t), `${where}：出现白名单外标签 <${t}>`);
  }
  // 提取每个开始标签内的真实属性（属性值必然带引号）。载荷中的
  // `onload=` 若出现在属性值里，其引号已被转义为 &quot;，不会匹配下面的正则。
  const attrNames = [...html.matchAll(/<[a-zA-Z][^>]*?(?:>|$)/g)].flatMap((m) =>
    [...m[0].matchAll(/(?:^|\s)([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*')/g)]
      .map((x) => x[1].toLowerCase()));
  for (const a of attrNames) {
    assert.ok(ALLOWED_ATTRS.has(a), `${where}：出现白名单外属性 ${a}=`);
  }
}

// 把实体解码为纯文本，模拟浏览器解析后用户看到的内容。
// 先解码 &amp;，再解码其余实体：&amp;quot; 应还原为字面 "&quot;"，
// 而不是被二次解码成引号（与 HTML 解析器对嵌套转义的处理一致）。
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// 去掉全部标签后得到可见文本；同时把属性值（如 title 提示）纳入“显示原文”范围
function visibleText(html) {
  const attrs = [...html.matchAll(/="([^"]*)"/g)].map((m) => m[1]).join('\n');
  return decodeEntities(`${html.replace(/<[^>]*>/g, '')}\n${attrs}`);
}

function assertPayloadVisible(html, payload, where) {
  // 原始载荷中的 < 必须以 &lt; 出现，绝不允许裸 < 直接拼载荷
  if (payload.includes('<')) {
    assert.ok(html.includes(ocEscapeHtml(payload)),
      `${where}：载荷应以实体编码原文出现`);
  }
  // 解码后的可见文本必须包含完整原文（只显示原文、不执行）
  assert.ok(visibleText(html).includes(payload),
    `${where}：解码后应能看到原始文本：${payload}`);
}

/* ---------------- 构造服务端返回形态 ---------------- */

function maliciousOffcut(status) {
  const reserved = status === 'reserved';
  return {
    id: 'OC-000001',
    paperName: NAME,
    w: 300, h: 100, area: 30000,
    paperWidth: 889, paperHeight: 1194,
    paperGrain: GRAIN_PAYLOAD,
    kerf: 3, x: 0, y: 0,
    source: {
      type: 'manual',
      batchId: BATCH,
      sheetIndex: 2,
      round: 1,
      orderNo: ORDER,
    },
    status,
    reservation: reserved ? {
      allocationId: AID,
      product: { width: 200, height: 80, grain: GRAIN_PAYLOAD },
      rotated: true,
      ref: REF,
      createdAt: '2026-09-23T08:00:00.000Z',
    } : null,
  };
}

/* ---------------- 列表渲染 ---------------- */

test('列表渲染：纸型名/订单号/批次号/单据号/编号/纹向均按文本上下文转义', () => {
  const html = ocListHtml([maliciousOffcut('reserved'), maliciousOffcut('available')]);
  assertSafeStaticStructure(html, '列表');
  for (const p of [NAME, ORDER, BATCH, AID, REF, GRAIN_PAYLOAD]) {
    assertPayloadVisible(html, p, `列表(${p})`);
  }
  // 正常中文与符号仍展示
  assert.ok(html.includes('已预占'));
  assert.ok(visibleText(html).includes('×'));
  // 空列表占位不受影响
  assert.ok(ocListHtml([]).includes('没有符合条件的余料'));
});

/* ---------------- 预占明细渲染 ---------------- */

test('预占明细：预占单号/单据号/编号转义，title 与 data-allocation 按属性上下文转义', () => {
  const html = ocAllocationsHtml([maliciousOffcut('reserved')]);
  assertSafeStaticStructure(html, '预占明细');
  // 该视图展示：预占单号、单据号、批次号（title 提示）、纹向标签
  for (const p of [AID, REF, BATCH, GRAIN_PAYLOAD]) {
    assertPayloadVisible(html, p, `预占明细(${p})`);
  }
  // 属性上下文中的载荷不得闭合属性 / 标签
  const titleMatch = html.match(/title="([^"]*)"/);
  assert.ok(titleMatch, '应存在 title 属性');
  assert.ok(!titleMatch[1].includes('"'), 'title 属性值中不应有未转义引号');
  const dataMatch = html.match(/data-allocation="([^"]*)"/);
  assert.ok(dataMatch, '应存在 data-allocation 属性');
  assert.ok(!dataMatch[1].includes('"'), 'data-allocation 属性值中不应有未转义引号');
  assert.equal(decodeEntities(dataMatch[1]), AID);
  // 无预占时返回空串
  assert.equal(ocAllocationsHtml([maliciousOffcut('available')]), '');
});

test('预占分组（整单结构）：单号/单据号/编号转义；被筛选掉的成员仍随整单渲染', () => {
  // 服务端新形态：{ allocationId, product, ref, createdAt, count, offcuts }
  const visible = maliciousOffcut('reserved'); // OC-000001
  const hidden = {
    ...maliciousOffcut('reserved'),
    id: 'OC-000002',
    w: 40, h: 30, // 尺寸更小：模拟被最小尺寸筛选排除
  };
  const groups = [{
    allocationId: AID,
    product: { width: 200, height: 80, grain: GRAIN_PAYLOAD },
    ref: REF,
    createdAt: '2026-09-23T08:00:00.000Z',
    count: 2,
    offcuts: [visible, hidden],
  }];

  // 明细只命中一块，但分组按整单渲染两块、总块数显示 2
  const html = ocAllocationsHtml(groups, [visible]);
  assertSafeStaticStructure(html, '预占分组');
  for (const p of [AID, REF, BATCH, GRAIN_PAYLOAD]) {
    assertPayloadVisible(html, p, `预占分组(${p})`);
  }
  assert.ok(html.includes('OC-000001'));
  assert.ok(html.includes('OC-000002'));
  assert.ok(visibleText(html).includes('占用'));
  // “占用 <b>2</b> 块”——整单 2 块，不随筛选裁剪
  assert.ok(/占用[\s\S]*<b>2<\/b>[\s\S]*块/.test(html), '应显示整单总块数 2');
  // 被筛掉的成员带弱化样式与“整单释放”提示
  assert.ok(html.includes('oc-chip-muted'));
  assert.ok(visibleText(html).includes('整单释放'));
  // data-allocation 仍为完整单号
  const dataMatch = html.match(/data-allocation="([^"]*)"/);
  assert.ok(dataMatch);
  assert.equal(decodeEntities(dataMatch[1]), AID);

  // 不传筛选明细（兼容调用）：不产生“被筛掉”提示，两块都正常显示
  const allVisible = ocAllocationsHtml(groups);
  assert.ok(!allVisible.includes('oc-chip-muted'));
  // 分组为空 / 无预占
  assert.equal(ocAllocationsHtml([]), '');
});

/* ---------------- 复用结果横幅 ---------------- */

test('复用成功结果：预占单号与单据号转义后展示原文', () => {
  const html = ocAllocationResultHtml({
    allocated: true,
    reservedCount: 1,
    allocationId: AID,
    feasibleCount: 2,
    request: { ref: REF },
  });
  assertSafeStaticStructure(html, '复用成功');
  assertPayloadVisible(html, AID, '复用成功(单号)');
  assertPayloadVisible(html, REF, '复用成功(单据)');
});

test('复用缺口结果：候选纸型名转义，静态统计标签保留', () => {
  const html = ocAllocationResultHtml({
    allocated: false,
    reservedCount: 0,
    feasibleCount: 1,
    shortfall: 2,
    blockedBySize: 3,
    blockedByGrain: 1,
    unavailableReserved: 0,
    request: { quantity: 3 },
    candidates: [
      { paperName: NAME, offcutId: 'OC-000009', width: 300, height: 100, rotated: false },
      { paperName: null, offcutId: 'OC-000010', width: 100, height: 50, rotated: true },
    ],
  });
  assertSafeStaticStructure(html, '复用缺口');
  assertPayloadVisible(html, NAME, '复用缺口(纸型名)');
  // 静态 <b> 统计数字仍存在
  assert.ok(html.includes('<b>缺口 2 块</b>'));
  // 无候选文案分支安全
  const none = ocAllocationResultHtml({
    allocated: false,
    feasibleCount: 0, shortfall: 1,
    blockedBySize: 0, blockedByGrain: 0, unavailableReserved: 1,
    request: { quantity: 1 },
    candidates: [],
  });
  assertSafeStaticStructure(none, '复用缺口(无候选)');
});

/* ---------------- 来源文本 ---------------- */

test('ocSourceText：批次号转义，枚举中文标签与符号正常显示', () => {
  const text = ocSourceText(maliciousOffcut('available'));
  assert.ok(!text.includes('<'), '来源文本不应含裸 <');
  assert.ok(visibleText(`<x>${text}</x>`).includes(BATCH));
  assert.ok(text.includes('手工'));
  assert.ok(text.includes('第2张'));
});
