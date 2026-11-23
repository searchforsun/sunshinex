import { applyFilePick, insertRefPick } from '../ui-util';
import { type Dispatch, type SetStateAction } from 'react';
import { t } from '../i18n';
import { FilePalette, fileHit, rankFileHits, slashTokenAt } from '../pages/Chat';
import { RefPalette } from '../pages/chat/mention';
import { CommandPalette, type CmdItem } from '../CommandPalette';
import { refPickLabel, refPanelItems as buildRefPanelItems } from '../pages/chat/ref-palette';
import type { RefEntries, RefPal } from '../pages/chat/ref-palette';
import { ComposerPlusPanel } from '../composer/ComposerPlusPanel';

import type { WelcomeComposerConn } from './welcome-conn';

/** D62 批E 自 WelcomeComposer 平移的 overlays 四面板链($/# 引用 → @ 文件 → / 命令 → + 附加):
 *  JSX 与宿主原段逐字等价,输入面全经 props 注入零闭包依赖(批B 判例同款)。 */
export function WelcomeOverlays({
  conn,
  goal,
  setGoal,
  goalRef,
  picked,
  refPal,
  setRefPal,
  refEntries,
  refActive,
  setRefActive,
  filePal,
  setFilePal,
  filePalFiles,
  filePalActive,
  setFilePalActive,
  welcomeSlashItems,
  welcomeCmdActive,
  setWelcomeCmdActive,
  plusOpen,
  setPlusOpen,
  attachImages,
  pickRelRef,
}: {
  conn: WelcomeComposerConn;
  goal: string;
  setGoal: Dispatch<SetStateAction<string>>;
  goalRef: React.RefObject<HTMLTextAreaElement | null>;
  picked: string;
  refPal: RefPal | null;
  setRefPal: Dispatch<SetStateAction<RefPal | null>>;
  refEntries: RefEntries;
  refActive: number;
  setRefActive: (v: number) => void;
  filePal: { query: string; from: number } | null;
  setFilePal: Dispatch<SetStateAction<{ query: string; from: number } | null>>;
  filePalFiles: string[];
  filePalActive: number;
  setFilePalActive: (v: number) => void;
  welcomeSlashItems: CmdItem[] | null;
  welcomeCmdActive: number;
  setWelcomeCmdActive: (v: number) => void;
  plusOpen: boolean;
  setPlusOpen: Dispatch<SetStateAction<boolean>>;
  attachImages: (files: File[]) => void;
  pickRelRef: React.MutableRefObject<Map<string, string>>;
}): JSX.Element {
  return (
    <>
      {/* $/# 引用面板链首(2026-11-05;与 Chat 同构互斥:在场时 @/+/命令面板一律不渲染) */}
      {refPal !== null && goal[refPal.from] === refPal.sym ? (
        (() => {
          const items = buildRefPanelItems(refEntries, refPal.query, refPal.sym);
          const emptyHint =
            refEntries.agents.length === 0 && refEntries.teams.length === 0
              ? t(
                  'No registered sub-agents or teams yet — create them in Settings → Agents / Agent Teams, then reference here with $ or #',
                  '尚无在册子智能体/团队 — 在 设置 → 智能体 / 智能体团队 创建后，即可在此 $ 引用 / # 拉队',
                )
              : t('No matching entry', '无匹配条目');
          return (
            <RefPalette
              items={items}
              emptyHint={emptyHint}
              active={Math.max(0, Math.min(refActive, items.length - 1))}
              onHover={setRefActive}
              onPick={(item) => {
                // 插入名称而非标识(2026-11-20 用户裁定,主对话同口径;发送期 expandRefNames 还原
                // id)——insertRefPick 单点(D85;分隔守卫/尾随空格/G14.211 光标钉随单点)
                insertRefPick(setGoal, {
                  sym: item.sym,
                  label: refPickLabel(item),
                  atFrom: refPal.from,
                  queryLen: refPal.query.length,
                  close: () => setRefPal(null),
                  pinTo: () => goalRef.current,
                });
              }}
            />
          );
        })()
      ) : // G14.121 @ 文件面板优先(命中才渲染;点击行=插入绝对路径,面板收起);
      // G14.211 锚点校验:@ 被删后面板残留在此拦下(同 Chat 渲染面)
      filePal !== null && picked !== '' && goal[filePal.from] === '@' && filePalFiles.some((f) => fileHit(f, filePal.query)) ? (
        <FilePalette
          items={rankFileHits(filePalFiles, filePal.query)}
          active={Math.min(filePalActive, 11)}
          onHover={setFilePalActive}
          onPick={(p) => {
            // G14.126 短写显形+记账;G14.211 焦点回框+光标钉——applyFilePick 单点(D86)
            applyFilePick(pickRelRef, setGoal, { rel: p, atFrom: filePal.from, queryLen: filePal.query.length, close: () => setFilePal(null), pinTo: () => goalRef.current });
          }}
        />
      ) : welcomeSlashItems !== null ? (
        (() => {
          // G14.213 欢迎页 / 命令+技能面板:行点击补全 `/cmd `(执行在会话建立后)
          const items = welcomeSlashItems;
          const active = Math.min(welcomeCmdActive, Math.max(0, items.length - 1));
          const pick = (item: CmdItem): void => {
            if (!item.ok) return;
            const tok = slashTokenAt(goal, goalRef.current?.selectionStart ?? goal.length);
            const from = tok !== null ? tok.from : goal.length;
            const caret = goalRef.current?.selectionStart ?? goal.length;
            setGoal(goal.slice(0, from) + item.cmd + ' ' + goal.slice(caret));
            setWelcomeCmdActive(0);
            goalRef.current?.focus();
          };
          return <CommandPalette items={items} active={active} onHover={setWelcomeCmdActive} onPick={pick} />;
        })()
      ) : plusOpen ? (
        <ComposerPlusPanel
          conn={conn}
          root={picked !== '' ? picked : undefined}
          onAttachImages={attachImages}
          onInsert={(text) => {
            setGoal((v) => (v.trim() === '' ? text : `${v.replace(/\s+$/, '')} ${text}`));
            setPlusOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
