#!/usr/bin/env node
/** sqlite-vec 驱动 spike（P1-G1 选型证据）：node:sqlite + vec0 加载、插入策略、KNN 语义 */
'use strict';
const { DatabaseSync } = require('node:sqlite');

const DIM = 4;

function f32buf(a) { return Buffer.from(new Float32Array(a).buffer); }
function f32hex(a) { return "x'" + Buffer.from(new Float32Array(a).buffer).toString('hex') + "'"; }

/** 分阶段探测，任一阶段失败不阻断后续诊断；返回结构化报告 */
function probe() {
  const report = { loadable: null, create: false, columns: [], insert: [], knn: null, size: 0, distanceRange: null, errors: [] };
  let db;
  try {
    const sv = require('sqlite-vec');
    report.loadable = sv.getLoadablePath();
    db = new DatabaseSync(':memory:', { allowExtension: true });
    db.loadExtension(report.loadable);
  } catch (e) { report.errors.push('load: ' + e.message); return report; }

  try { db.exec(`CREATE VIRTUAL TABLE vt USING vec0(embedding float[${DIM}])`); report.create = true; }
  catch (e) { report.errors.push('create: ' + e.message); return report; }

  try { report.columns = db.prepare('PRAGMA table_info(vt)').all().map((c) => c.name); }
  catch (e) { report.errors.push('pragma: ' + e.message); }

  const ins = db.prepare('INSERT INTO vt(rowid, embedding) VALUES (?, ?)');
  // 策略1：JSON 文本绑定（vec0 文档输入格式，运行时首选）
  try { ins.run(1, JSON.stringify([1, 0, 0, 0].slice(0, DIM))); report.insert.push({ name: 'json-text', ok: true }); }
  catch (e) { report.insert.push({ name: 'json-text', ok: false, err: e.message }); }
  // 策略2：blob 绑定（已知 vec0 对主键值类型校验严格，备案用）
  if (report.insert.every((i) => !i.ok)) {
    try { ins.run(2, f32buf([0, 1, 0, 0].slice(0, DIM))); report.insert.push({ name: 'blob', ok: true }); }
    catch (e) { report.insert.push({ name: 'blob', ok: false, err: e.message }); }
  }
  // 策略3：hex 字面量 exec（已验证可用的兜底）
  if (report.insert.every((i) => !i.ok)) {
    try { db.exec(`INSERT INTO vt(rowid, embedding) VALUES (3, ${f32hex([0, 0, 1, 0])})`); report.insert.push({ name: 'hex', ok: true }); }
    catch (e) { report.insert.push({ name: 'hex', ok: false, err: e.message }); }
  }

  try { report.size = db.prepare('SELECT COUNT(*) AS c FROM vt').get().c; }
  catch (e) { report.errors.push('count: ' + e.message); }

  // KNN：k = ? 形式优先，回退 ORDER BY distance LIMIT；查询向量形态与成功插入策略一致
  const okStrategy = report.insert.find((i) => i.ok);
  const qInput = okStrategy && okStrategy.name === 'blob' ? f32buf([1, 0, 0, 0]) : JSON.stringify([1, 0, 0, 0]);
  try { report.knn = { form: 'k-param', rows: db.prepare('SELECT rowid, distance FROM vt WHERE embedding MATCH ? AND k = ?').all(qInput, 2) }; }
  catch (e1) {
    try { report.knn = { form: 'order-limit', rows: db.prepare('SELECT rowid, distance FROM vt WHERE embedding MATCH ? ORDER BY distance LIMIT 2').all(qInput) }; }
    catch (e2) { report.errors.push('knn: ' + e1.message + ' | ' + e2.message); }
  }
  if (report.knn && report.knn.rows.length) report.distanceRange = { top: report.knn.rows[0].distance, last: report.knn.rows[report.knn.rows.length - 1].distance };

  if (typeof db.close === 'function') db.close();
  return report;
}

module.exports = { probe, DIM };
if (require.main === module) console.log(JSON.stringify(probe(), null, 2));
