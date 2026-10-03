import * as path from 'path';
import { resolveKbEnv } from '../../config/env';
import { indexKnowledgeDir } from '../../harness/knowledge';
import { t } from '../../i18n';
import type { CliArgs } from '../index';

/**
 * kb-index 子命令（D28 裁决落点）：对目录构建 KB 索引，与 TUI /kb-index 共用 knowledge 层单点 indexKnowledgeDir。
 * 成本语义：索引对目录内全部 md/txt 走真实计费 embedding——命令由用户显式触发，成本可控性由文件数决定。
 * 目录缺省 = 当前工作区（与 TUI /kb-index 缺省会话根同口径）；kb 未配置 → 指出缺失 env 并指向 MANUAL 第二节 + exit 1。
 */
export async function runKbIndex(args: CliArgs): Promise<void> {
  // root 锚 = cwd（selfcheck 同口径）：KB 数据目录按工作区解析，与「在该目录启动会话」的检索视图一致
  const root = process.cwd();
  if (args.positional.length > 1) {
    console.warn(t(
      `ignoring extra positional args: ${args.positional.slice(1).join(' ')}`,
      `多余位置参数已忽略：${args.positional.slice(1).join(' ')}`,
    ));
  }
  const target = path.resolve(args.positional[0] ?? root);
  const cfg = resolveKbEnv(process.env as Record<string, string | undefined>);
  const r = await indexKnowledgeDir(cfg, root, target);
  if (!r.ok) {
    if (r.reason === 'not-configured') {
      console.error(t(
        `Knowledge base not configured — missing ${r.missing.join(', ')}. Set the embedding config (see MANUAL.md section 2), then rerun sunshinex kb-index.`,
        `知识库未配置——缺 ${r.missing.join('、')}。请先配置 embedding（见 MANUAL.md 第二节）再重跑 sunshinex kb-index。`,
      ));
    } else {
      console.error(t(`Not a directory: ${r.dir}`, `目录不存在或不是目录：${r.dir}`));
    }
    process.exitCode = 1;
    return;
  }
  console.log(t(
    `Knowledge base index built: ${r.chunks} chunks (backend=${r.backend}, dataDir=${r.dataDir})`,
    `知识库索引已构建：${r.chunks} 块（backend=${r.backend}，数据目录 ${r.dataDir}）`,
  ));
}
