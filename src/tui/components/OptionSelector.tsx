import { t } from '../../i18n';
import * as React from 'react';
import { Box, Text } from 'ink';

/** 选择器选项（AskUserRequest.options 同形；独立定义避免渲染层反向依赖 harness 类型） */
export interface SelectorOption {
  label: string;
  description?: string;
}

export interface OptionSelectorProps {
  question: string;
  options: SelectorOption[];
  /** 高亮行（0-based；↑↓ 键经 moveCursor 归位） */
  cursor: number;
  /** 已选下标集合（单选恒单元素、多选升序） */
  picked: number[];
  multiple?: boolean;
  title?: string;
  /** 底部键位提示行；缺省 = move/select/submit/cancel 四段（外观双语） */
  hint?: string;
}

/** ↑（dir=-1）/↓（dir=1）循环移动高亮：首尾回环（对标 CC 选择器），len<=0 兜底 0 */
export function moveCursor(cursor: number, len: number, dir: number): number {
  if (len <= 0) return 0;
  return (cursor + dir + len) % len;
}

/** Space 选定语义：单选覆盖为当前项（即选即提交由调用方承载）；多选翻转勾选、追加保升序（answers 按选项序拼接不漂移） */
export function togglePick(picked: number[], idx: number, multiple: boolean): number[] {
  if (!multiple) return [idx];
  if (picked.includes(idx)) return picked.filter((p) => p !== idx);
  return [...picked, idx].sort((a, b) => a - b);
}

/** 统一选择器（规格 D4）：题头 + 序号选项行 + 键位提示。纯受控渲染——光标/勾选态由调用方持有，
 *  键盘分发收敛在 App 层（权限卡/plan 卡/AskQuestion 卡/Resume 列表四消费面共用），本组件不挂 useInput */
export function OptionSelector({ question, options, cursor, picked, multiple, title, hint }: OptionSelectorProps): JSX.Element {
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      {title ? <Text bold>{title}</Text> : null}
      <Text bold>{question}</Text>
      {options.map((o, i) => {
        const cursorMark = i === cursor ? '❯ ' : '  ';
        const pickMark = multiple ? (picked.includes(i) ? '◉ ' : '○ ') : '';
        return (
          <Text key={`${i}-${o.label}`}>
            {cursorMark}
            {pickMark}
            {i + 1}. {o.label}
            {o.description ? <Text dimColor> — {o.description}</Text> : null}
          </Text>
        );
      })}
      <Text dimColor>{hint ?? t('↑/↓ move · space select · enter submit · esc cancel', '↑/↓ 移动 · 空格选定 · 回车提交 · Esc 取消')}</Text>
    </Box>
  );
}
