#!/usr/bin/env node
// 一次性补传脚本(2026-10-25 v0.5.0 发版:release.mjs 内置 fetch 对 121MB setup.exe 反复
// UND_ERR_HEADERS_TIMEOUT/进程中断,Release 附件被 --clobber 删空)。本脚本只补附件,不构建:
// 凭据走 git credential fill(同 release.mjs 通道③,token 不打印),上传走 curl 流式(-T,
// 无 undici headersTimeout 限制,直连 uploads.github.com;API 查询走 fetch + NODE_USE_SYSTEM_CA)。
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'searchforsun/sunshinex';
const TAG = 'v0.5.0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = [
  path.join(ROOT, 'sunshinex-agent-0.5.0.tgz'),
  path.join(ROOT, 'shell', 'release', 'sunshinex-0.5.0-setup.exe'),
];

const die = (m) => { console.error('upload-assets: ' + m); process.exit(1); };
const say = (m) => console.log('upload-assets: ' + m);

// 1) 凭据:git credential fill(host github.com)——password 即 PAT(OAuth token);绝不回显
let token = '';
try {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  }).split('\n').find((l) => l.startsWith('password='));
  token = (out ?? '').slice('password='.length).trim();
} catch { /* fallthrough */ }
if (!token) die('git 凭据助手未取到 github.com 凭据(能 git push 通常即有)');

// 2) 查 Release(API fetch;TLS 拦截环境走系统信任库)
const relRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
}).catch((e) => die('查询 Release 失败: ' + (e?.cause?.code ?? e?.message)));
if (relRes.status !== 200) die(`查询 Release 失败 HTTP ${relRes.status}(tag 未建?先走 release.mjs 建 Release)`);
const rel = await relRes.json();
say(`Release ${rel.name} (id=${rel.id}) 现有附件: ${rel.assets.map((a) => `${a.name}(${a.size})`).join(', ') || '无'}`);

// 3) 逐附件:删同名旧件 → curl 流式上传 → 校验 size
for (const file of ASSETS) {
  const name = path.basename(file);
  if (!fs.existsSync(file)) die(`本地产物缺失: ${file}(先跑 release.mjs 产出)`);
  const size = fs.statSync(file).size;
  const old = rel.assets.find((a) => a.name === name);
  if (old) {
    const del = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${old.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    }).catch((e) => die(`删除旧附件 ${name} 失败: ${e?.cause?.code ?? e?.message}`));
    if (del.status !== 204) die(`删除旧附件 ${name} HTTP ${del.status}`);
    say(`已删除旧附件 ${name}(${old.size})`);
  }
  const url = `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`;
  say(`上传 ${name}(${(size / 1024 / 1024).toFixed(1)}MB)……`);
  const up = execFileSync('curl', [
    '--http1.1', '-sS', '-X', 'POST', '-T', file, url,
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/octet-stream',
    '--connect-timeout', '30', '--max-time', '3600',
  ], { encoding: 'utf8' });
  let uploaded = null;
  try { uploaded = JSON.parse(up); } catch { die(`上传 ${name} 响应非 JSON: ${up.slice(0, 200)}`); }
  if (uploaded.message) die(`上传 ${name} 失败: ${uploaded.message}`);
  if (uploaded.size !== size) die(`上传 ${name} 校验不符: 远端 ${uploaded.size} ≠ 本地 ${size}`);
  say(`已上传 ${name}(${(uploaded.size / 1024 / 1024).toFixed(1)}MB) ✓`);
}
say('全部附件就绪: https://github.com/' + REPO + '/releases/tag/' + TAG);
