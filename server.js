'use strict';

const path = require('node:path');
const express = require('express');
const { layout, layoutBatch, layoutCompare } = require('./src/packer');
const { layoutCostBatch } = require('./src/cost');
const { stackSchedule } = require('./src/stack');
const { workOrder, workOrderCsv } = require('./src/workorder');
const { workOrderProgress } = require('./src/progress');
const { samplingPlan } = require('./src/sampling');
const {
  ingestOffcuts,
  createOffcut,
  listOffcuts,
  allocateOffcuts,
  releaseAllocations,
  initPersistence,
  SnapshotError,
} = require('./src/offcuts');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// 余料库存快照：每次录入 / 登记 / 预占 / 释放先原子写盘再发布；
// 启动时恢复余料、预占关系与三个自动编号，快照损坏则拒绝启动。
// 默认 /app/data/offcuts-snapshot.json（Docker 数据卷挂载点）；
// 本地直接运行时默认 ./data/offcuts-snapshot.json，可用 OFFCUTS_SNAPSHOT 覆盖，
// 置空则退化为纯进程内存模式。
const DEFAULT_SNAPSHOT = process.env.OFFCUTS_SNAPSHOT !== undefined
  ? process.env.OFFCUTS_SNAPSHOT
  : path.join(__dirname, 'data', 'offcuts-snapshot.json');

(function restoreAtStartup() {
  try {
    const info = initPersistence(DEFAULT_SNAPSHOT || null);
    if (info && info.restored) {
      console.log(`已恢复余料库存快照：${info.offcutCount} 块余料，`
        + `${info.allocationIds.length} 个有效预占单`);
    }
  } catch (err) {
    console.error(`启动失败：${err.message}`);
    process.exit(1);
  }
})();

// 叠纸排程会回传多张纸的完整切割树（最多 500 张），放宽请求体上限
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/layout', (req, res) => {
  try {
    const body = req.body || {};
    const result = layout(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 方案比选：同一输入按三种确定性策略分别试排，按比选目标择优
app.post('/api/layout/compare', (req, res) => {
  try {
    const body = req.body || {};
    const result = layoutCompare(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 批量排产：逐张排样直到完成 / 达到上限 / 某张纸无进展
app.post('/api/layout/batch', (req, res) => {
  try {
    const body = req.body || {};
    const result = layoutBatch(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 多纸型成本排产：2～8 种候选纸逐轮按单位面积成本择优
app.post('/api/layout/cost', (req, res) => {
  try {
    const body = req.body || {};
    const result = layoutCostBatch(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 叠纸裁切排程：复用批量/多纸型排产结果，把各张纸的断头台切割树
// 按合批规则（区域宽高、刀向、刀位、刀缝一致）与父刀先后约束转换为刀次
app.post('/api/layout/stack', (req, res) => {
  try {
    const body = req.body || {};
    const result = stackSchedule(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 执行工单：在叠纸排程结果上按班次容量（每班最多刀次、每批最多纸张）
// 做稳定拓扑拆分，输出班次/刀次清单、跨班次依赖与未分配刀；?format=csv 直接下载
app.post('/api/layout/stack/work-order', (req, res) => {
  try {
    const body = req.body || {};
    const format = typeof req.query.format === 'string'
      ? req.query.format
      : (typeof body.format === 'string' ? body.format : 'json');
    const result = workOrder(body);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="work-order.csv"');
      res.send(workOrderCsv(result));
      return;
    }
    if (format !== 'json') {
      res.status(400).json({ error: 'format 仅支持 json 或 csv' });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 现场进度：为工单中每个已分配刀次汇总全部成员纸张的父刀依赖，
// 接收已完成全局刀号，返回可立即执行/仍阻塞刀次、待完成父刀与班次/整单完成率
app.post('/api/layout/stack/work-order/progress', (req, res) => {
  try {
    const body = req.body || {};
    const result = workOrderProgress(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 裁切抽检计划：把每个已分配全局刀次作为必覆盖目标，一张纸被抽中即覆盖
// 其参与的全部刀次；按新增覆盖刀次→参与刀次总数→纸张序号逐轮选纸
app.post('/api/layout/stack/work-order/sampling', (req, res) => {
  try {
    const body = req.body || {};
    const result = samplingPlan(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

/* ---------------- 余料库存与复用预占 ---------------- */

// 输入校验错误返回 400；库存快照写盘 / 读取失败返回 500（库存与编号未前进）
function sendOffcutError(res, err) {
  const status = err instanceof SnapshotError ? 500 : 400;
  res.status(status).json({ error: err.message || (status === 500 ? '库存服务错误' : '输入无效') });
}

// 余料录入：手工录入单条余料（纸型/纹向/刀缝/尺寸/来源批次）
app.post('/api/offcuts', (req, res) => {
  try {
    const result = createOffcut(req.body || {});
    res.status(201).json(result);
  } catch (err) {
    sendOffcutError(res, err);
  }
});

// 余料批量登记：把现有排料结果（单张 / 批量 / 多纸型成本 / 方案比选）
// 每张纸 layout.frees 标准化为可追踪余料记录
app.post('/api/offcuts/ingest', (req, res) => {
  try {
    const result = ingestOffcuts(req.body || {});
    res.status(201).json(result);
  } catch (err) {
    sendOffcutError(res, err);
  }
});

// 余料查询：可用 / 已预占、最小尺寸、纹向、关键字。
// 明细列表遵循全部筛选条件；同次库存读取另返回完整已预占单分组
// （allocationGroups，不随筛选裁剪）——组内编号、总块数与整单释放按钮
// 始终对应整单，明细被筛选掉时分组仍可见。
app.get('/api/offcuts', (req, res) => {
  try {
    const result = listOffcuts(req.query || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 复用预占：给定成品宽高、数量与纹向要求，按旋转/纹向可行性与
// 最小剩余面积确定性选择余料；原子预占足量余料，无法满足时
// 不扣减任何已占用记录并返回缺口明细（HTTP 200，status:'shortfall'）
app.post('/api/offcuts/allocate', (req, res) => {
  try {
    const result = allocateOffcuts(req.body || {});
    res.json(result);
  } catch (err) {
    sendOffcutError(res, err);
  }
});

// 释放预占：按预占单号或余料编号一次性释放
app.post('/api/offcuts/release', (req, res) => {
  try {
    const result = releaseAllocations(req.body || {});
    res.json(result);
  } catch (err) {
    sendOffcutError(res, err);
  }
});

app.listen(PORT, () => {
  console.log(`单张纸裁切试排服务已启动: http://localhost:${PORT}`);
});

module.exports = app;
