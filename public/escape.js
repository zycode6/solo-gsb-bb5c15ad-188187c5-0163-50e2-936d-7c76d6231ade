'use strict';

/*
 * 通用 HTML 上下文转义工具（由 offcuts.js 与 Node 回归测试共用）。
 *
 * 余料库存与复用页中，手工录入 / 排料结果登记的纸型名、订单号、批次号、
 * 单据号等动态值会进入 innerHTML 拼接，必须先按所在上下文转义后再渲染，
 * 防止存储型脚本注入：
 *  - ocEscapeHtml：HTML 文本上下文（元素开始/结束标签之间）；
 *  - ocEscapeAttr：HTML 属性上下文（双引号属性值），同一转义集即可中和
 *    引号逃逸与事件属性注入。
 * 转义只影响 < > & " ' 的显示编码，中文与常见符号（× ↔ · 等）原样保留。
 *
 * 浏览器中作为普通 <script> 加载（与 offcuts.js 共享全局作用域），因此
 * 函数仅在 IIFE 内声明，再挂到 window，避免顶层词法标识符冲突。
 */

(function () {
  function ocEscapeHtml(value) {
    if (value == null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 属性值统一以双引号包裹（如 title="${...}"），转义 " 即可阻止属性逃逸；
  // 同时转义 < > & '，与文本上下文保持同一安全基线。
  const ocEscapeAttr = ocEscapeHtml;

  const api = { ocEscapeHtml, ocEscapeAttr };

  if (typeof window !== 'undefined') {
    window.ocEscapeHtml = ocEscapeHtml;
    window.ocEscapeAttr = ocEscapeAttr;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
