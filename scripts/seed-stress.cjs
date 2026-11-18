#!/usr/bin/env node
/**
 * 转录压力数据播种/清理(维护者工具,不进安装包):
 *
 *   node scripts/seed-stress.cjs            # 造 12 个项目(6 个各 1200 条 + 6 个各 24 条)
 *   node scripts/seed-stress.cjs --clean    # 移除本工具造的全部数据(只认 SX_STRESS_ROOT 派生)
 *
 * 投递目标 = settings.json 的 projectsDir(运行中 daemon 真实数据根):每个项目写
 *   <projectsDir>/<projectSlug(root)>/data/workspace.json + data/sessions/<id>.jsonl(.meta.json)
 * session jsonl 用 v3 段级词汇(header + user 摘要行 + seg/seg-update 交替),daemon attach 时
 * 经 reduceSegRows 回放;1200 条=200 轮(用户/思考/工具×3/正文)。根目录默认 D:/sx-stress,
 * 可用 SX_STRESS_ROOT 覆盖。造完在 GUI 里聚焦窗口(或等 30s)侧栏即出现新项目。
 *
 * 清理只删两类目录:①<projectsDir> 下 workspace.json 的 root 落在 SX_STRESS_ROOT 内的 slug 目录;
 * ②SX_STRESS_ROOT 本身。不触碰既有工作区。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { projectSlug } = require('../dist/config/data-dir.js');

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.sunshinex', 'settings.json'), 'utf8'));
const projectsRoot = settings.projectsDir;
const stressRoot = path.resolve(process.env.SX_STRESS_ROOT || 'D:/sx-stress');
const clean = process.argv.includes('--clean');
const PROJECTS = 12;
const HEAVY = 6;
const ENTRIES = 1200;

const now = Date.now();
const day = 24 * 60 * 60 * 1000;

function seededSlugs() {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const file = path.join(projectsRoot, ent.name, 'data', 'workspace.json');
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof raw.root === 'string' && path.resolve(raw.root).startsWith(stressRoot)) out.push(ent.name);
    } catch {
      /* 无档/坏档不是本工具造的 */
    }
  }
  return out;
}

if (clean) {
  for (const slug of seededSlugs()) fs.rmSync(path.join(projectsRoot, slug), { recursive: true, force: true });
  fs.rmSync(stressRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ cleaned: seededSlugs().length === 0, projectsRoot, stressRoot }));
  process.exit(0);
}

const assistantBody = (i) => {
  const base = `第 ${i} 轮回复：这个模块的边界条件主要落在三处——输入为空、索引越界、并发重入。` +
    '我建议把校验前移到入口，用守卫提前返回，同时补上覆盖这三类分支的测试用例。';
  if (i % 4 !== 0) return `${base}\n\n补充：当前实现与预期行为一致，无需额外改动。`;
  return `${base}\n\n\`\`\`ts\nfunction guard(input: string | undefined): string {\n  if (input === undefined || input.trim() === '') return '';\n  return input.trim();\n}\n\`\`\`\n\n- 入口校验\n- 越界保护\n- 并发幂等\n`;
};

function mkWorkspace(n) {
  const name = `proj-${String(n).padStart(2, '0')}`;
  const root = path.resolve(path.join(stressRoot, name));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), `# Stress project ${n}\n\nSynthetic workspace for transcript stress testing.\n`);
  for (let f = 1; f <= 3; f += 1) fs.writeFileSync(path.join(root, 'src', `mod${f}.ts`), `export const mod${f} = ${f};\n`);
  const dataDir = path.join(projectsRoot, projectSlug(root), 'data');
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify({ root }));
  return { name, root, dataDir };
}

function seedSession(ws, n, entries) {
  const id = `20261118T${String(100000 + n).slice(1)}Z-st${String(n).padStart(2, '0')}`;
  const lines = [];
  lines.push(JSON.stringify({ t: 'header', v: 3, id, createdAt: new Date(now - day).toISOString() }));
  lines.push(JSON.stringify({ t: 'user', text: `压力会话 ${n}：检查 ${ws.name} 的边界条件并给出修复建议` }));
  let seq = 0;
  let ts = now - day;
  for (let i = 1; i <= entries; i += 1) {
    const phase = i % 6;
    ts += 900;
    seq += 1;
    const seg = (kind, extra) => lines.push(JSON.stringify({ t: 'seg', kind, ts, seq, ...extra }));
    if (phase === 1) seg('user', { md: `任务 ${i}：请检查模块 ${((i - 1) % 50) + 1} 的边界条件，给出修复建议。` });
    else if (phase === 2) seg('thinking', { md: `先梳理第 ${i} 项的需求：输入来源、调用方约束、失败路径。` });
    else if (phase === 3) seg('tool', { name: 'read_file', input: { path: `src/mod${(i % 50) + 1}.ts` }, callId: `step:${seq}-call`, md: '' });
    else if (phase === 4) seg('tool', { name: 'grep', input: { pattern: 'guard|assert|throw', path: 'src' }, callId: `step:${seq}-call`, md: '' });
    else if (phase === 5) seg('tool', { name: 'exec', input: { command: `node -e "console.log(${i})"` }, callId: `step:${seq}-call`, md: 'ok' });
    else seg('assistant', { md: assistantBody(i) });
  }
  fs.writeFileSync(path.join(ws.dataDir, 'sessions', `${id}.jsonl`), lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(
    path.join(ws.dataDir, 'sessions', `${id}.meta.json`),
    JSON.stringify({ updatedAt: ts, root: ws.root, title: `压力会话 ${n}(${entries} 条)`, runs: Math.ceil(entries / 6), steps: entries, tokens: entries * 220, seconds: entries * 2, model: 'deepseek-flash' }),
  );
  return id;
}

const seeded = [];
for (let n = 1; n <= PROJECTS; n += 1) {
  const ws = mkWorkspace(n);
  const entries = n <= HEAVY ? ENTRIES : 24;
  seeded.push({ project: ws.name, root: ws.root, journal: seedSession(ws, n, entries), entries });
}
console.log(JSON.stringify({ projectsRoot, stressRoot, seeded }, null, 2));
