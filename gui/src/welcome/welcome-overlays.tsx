import { type Dispatch, type SetStateAction } from 'react';
import { t } from '../i18n';
import { FilePalette, fileHit, rankFileHits, slashTokenAt } from '../pages/Chat';
import { RefPalette } from '../pages/chat/mention';
import { CommandPalette, type CmdItem } from '../CommandPalette';
import { flatRefItems } from '../pages/chat/ref-palette';
import type { RefEntries, RefPal } from '../pages/chat/ref-palette';
import { ComposerPlusPanel } from '../composer/ComposerPlusPanel';
import { pathBasename } from '../ui-util';
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
          const items = flatRefItems(refEntries, refPal.query, refPal.sym);
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
                const from = refPal.from;
                const end = from + 1 + refPal.query.length;
                setGoal((prev) => prev.slice(0, from) + `${item.sym}${item.id} ` + prev.slice(Math.max(end, from)));
                setRefPal(null);
                goalRef.current?.focus();
                requestAnimationFrame(() => {
                  const g = goalRef.current;
                  if (g === null) return;
                  const to = Math.min(from + item.id.length + 2, g.value.length);
                  g.setSelectionRange(to, to);
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
            // G14.126 选中只插短写 @文件名,相对路径记账供发送期展开
            const base = pathBasename(p);
            pickRelRef.current.set(base, p);
            const atFrom = filePal.from;
            const atEnd = atFrom + 1 + filePal.query.length;
            setGoal((prev) => prev.slice(0, atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, atFrom)));
            setFilePal(null);
            // G14.211 焦点回输入框 + 光标钉在插入 token 之后(面板行点击带走焦点,
            // 不回焦则后续键入落空;旧光标位恢复=token 中间)
            goalRef.current?.focus();
            requestAnimationFrame(() => {
              const g = goalRef.current;
              if (g === null) return;
              const to = Math.min(atFrom + base.length + 2, g.value.length);
              g.setSelectionRange(to, to);
            });
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
