#!/usr/bin/env node
/**
 * 旧会话档清理(session-kernel spec §5 无兼容策略;P11-T2 起 attach 只认 v3):
 * 扫描指定目录(缺省常见 dataDir 位点)下 sessions/*.jsonl——首行 header v≠3 的 v1/v2 旧档与
 * `<id>.transcript.jsonl`(G14.213b 第二档残迹)列为 legacy;--delete 才删,缺省 dry-run 列表。
 * 用法:node scripts/purge-legacy-sessions.mjs [dir ...] [--delete]
 * 常见位点:~/.sunshinex/sessions、各工作区 .sunshinex/sessions。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const args = process.argv.slice(2);
const del = args.includes('--delete');
const dirs = args.filter((a) => !a.startsWith('--')).map((d) => path.resolve(d));
if (dirs.length === 0) {
  dirs.push(path.join(os.homedir(), '.sunshinex', 'sessions'));
  dirs.push(path.join(process.cwd(), '.sunshinex', 'sessions'));
}

const isJsonl = (n) => n.endsWith('.jsonl');
const isTranscriptSidecar = (n) => n.endsWith('.transcript.jsonl');

function headerVersion(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const first = buf.toString('utf8', 0, n).split('\n')[0] ?? '';
    const h = JSON.parse(first);
    return h?.t === 'header' && typeof h.v === 'number' ? h.v : -1;
  } catch {
    return -1;
  }
}

const targets = [];
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!isJsonl(name)) continue;
    const file = path.join(dir, name);
    if (isTranscriptSidecar(name)) {
      targets.push({ file, why: 'G14.213b 第二档残迹' });
      continue;
    }
    const v = headerVersion(file);
    if (v !== 3) targets.push({ file, why: `旧档(header v=${v})` });
  }
}

if (targets.length === 0) {
  console.log('purge: 无旧档(全 v3 或空)');
  process.exit(0);
}
for (const { file, why } of targets) console.log(`${del ? 'DEL' : 'LEGACY'}  ${file}  (${why})`);
if (del) {
  for (const { file } of targets) {
    try {
      fs.rmSync(file);
    } catch (e) {
      console.error(`purge: 删除失败 ${file}: ${e?.message ?? e}`);
    }
  }
  console.log(`purge: 已删除 ${targets.length} 个旧档`);
} else {
  console.log(`purge: 共 ${targets.length} 个旧档(dry-run;加 --delete 执行删除)`);
}
