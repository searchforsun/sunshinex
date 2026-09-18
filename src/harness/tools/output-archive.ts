import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** 出口预算常量（规格 §3，代码内钉住不加 env）：超限全文落盘、链上留预览+恢复路径 */
export const TOOL_OUTPUT_CHAR_LIMIT = 30_000;
export const PREVIEW_CHARS = 2_000;

export interface ToolOutputArchive {
  /**
   * 工具出口预算单点：≤上限逐字节原样返回（不触目录解析）；超限截断为预览 + 落盘路径提示。
   * 落盘失败降级为纯截断提示，永不向上抛（压缩/工具链永不因归档失败而失败）。
   */
  fit(tool: string, output: string): string;
}

/**
 * 工具输出归档接缝（对标 Claude Code tool_result_budget 形态）。
 * 目录经 resolveDir 惰性求值——对齐 env 运行期求值先例，测试可自由重定向 SUNSHINEX_DATA_DIR，
 * 未超限的常规路径零目录解析开销；写入函数可注入（测试桩模拟磁盘故障）。
 * 落盘为纯文本原文（非 JSON 转义形态），模型经 read <path> 即取回完整内容（恢复路径纪律）。
 */
export function createToolOutputArchive(
  resolveDir: () => string,
  writeFile: (file: string, content: string) => void = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  },
): ToolOutputArchive {
  let seq = 0;
  return {
    fit(tool: string, output: string): string {
      if (output.length <= TOOL_OUTPUT_CHAR_LIMIT) return output;
      seq += 1;
      const digest = createHash('sha1').update(output).digest('hex').slice(0, 8);
      const preview = output.slice(0, PREVIEW_CHARS);
      try {
        const file = path.join(resolveDir(), 'tool-outputs', `${seq}-${tool}-${digest}.txt`);
        writeFile(file, output);
        return `${preview}\n[truncated · full output: ${file}]`;
      } catch {
        return `${preview}\n[truncated]`;
      }
    },
  };
}
