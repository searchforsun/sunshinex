import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { errText } from './ui-util';
import { useAutoToast } from './use-auto-toast';

/**
 * raw 文本编辑面共享 hook（D92 收敛，2026-11-23 续轮七）：GlobalRulesPane 与 RawPane 原
 * 「readGenRef 代际竞态回显+save+toast 3s（useAutoToast）+textarea 自增长 ≥320+保存禁用
 * loaded 门」全同构双写，差异仅端点与重读清场语义——本 hook 参数化承载：
 * - read/write：各面端点（sunshineGet/Put vs settingsRaw/putSettingsRaw）
 * - readDeps：自动回显依赖面（mount + 各面信号：refreshTick / 文件切换）
 * - resetBeforeAutoRead：自动回显前清场（Raw 切文件面 content/loaded 清零保存禁用——陈旧
 *   内容不跨文件写；GlobalRules 原文保留在途换新=「重新读取以磁盘为准」语义）
 * 手动「重新读取」恒不清场（两面同：编辑中途弃改回磁盘现值，代守卫弃迟到应答）。
 */
export interface RawEditorOpts {
  read: () => Promise<{ content: string | null }>;
  write: (content: string) => Promise<void>;
  /** 自动回显 effect 依赖面（mount + 各面信号） */
  readDeps: readonly unknown[];
  /** 自动回显前清场（见头注）；缺省 false（原文保留在途换新） */
  resetBeforeAutoRead?: boolean;
}

export function useRawEditor(opts: RawEditorOpts): {
  content: string;
  setContent: (v: string) => void;
  loaded: boolean;
  loadError: string;
  saveError: string;
  saving: boolean;
  toast: string | null;
  editorRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  /** 手动「重新读取」（不清场） */
  readNow: () => void;
  save: () => void;
} {
  const { read, write, readDeps, resetBeforeAutoRead = false } = opts;
  const [content, setContent] = useState('');
  /** 未读取态判据（保存禁用门）：mount/切档重读在途——陈旧内容不写 */
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  /** toast 3s 自隐（useAutoToast 单点） */
  const { toast, showToast, clearToast } = useAutoToast<string>();
  /** read 代计数（在途竞态守卫，镜像 SettingsForm loadGenRef）：重读发起即递增，迟到应答弃 */
  const readGenRef = useRef(0);
  /** 编辑器自增长锚（高度随原文撑开，下限 320，滚动交外层面） */
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  // 自增长:content 变化即重算高度(scrollHeight 撑开,下限 320);先置 auto 归零防旧高钳制
  useEffect(() => {
    const el = editorRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight + 2, 320)}px`;
  }, [content]);

  const fetchInto = (reset: boolean): void => {
    const gen = ++readGenRef.current;
    if (reset) {
      setContent('');
      setLoaded(false);
    }
    setLoadError('');
    setSaveError('');
    clearToast();
    read().then(
      (v) => {
        if (readGenRef.current !== gen) return; // 陈旧代:已切走/新代在途——弃,不置 loaded/不装内容
        setContent(v.content ?? ''); // null = 缺文件:空编辑器（首存建档）
        setLoaded(true);
      },
      (err: unknown) => {
        if (readGenRef.current !== gen) return; // 陈旧代:错误也不落
        setLoadError(errText(err));
      },
    );
  };

  // 自动回显:mount 与 readDeps 变化即重读（读中清错误/toast）
  useEffect(() => {
    fetchInto(resetBeforeAutoRead === true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, readDeps);

  const readNow = (): void => fetchInto(false);

  const save = (): void => {
    if (saving || !loaded) return;
    setSaving(true);
    setSaveError('');
    write(content).then(
      () => {
        setSaving(false);
        showToast(t('Saved — applies to new sessions', '已保存：新建会话起'));
      },
      (err: unknown) => {
        setSaving(false);
        setSaveError(errText(err)); // 400 解析错误原文行内示出（raw 严格口径在服务端）
      },
    );
  };

  return { content, setContent, loaded, loadError, saveError, saving, toast, editorRef, readNow, save };
}
