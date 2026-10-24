/**
 * 欢迎页 composer 的 conn 结构面（D42 外提：App 传整只 Connection 结构满足——最小接缝，
 * 与 ProjectMenuConn/DirPickerConn 同构；原内联 16 方法签名且 gitBranches/gitCheckout
 * 重复声明两份，此处单点）。
 */
export interface WelcomeComposerConn {
  dirpicker(path?: string): Promise<{ path: string; parent: string; dirs: string[] }>;
  workspaces(): Promise<Array<{ slug: string; root?: string; sessionCount: number }>>;
  newSession(root: string, mode?: 'acceptEdits' | 'full-access'): Promise<{ sessionId: string }>;
  /** 建项目(G10-C11):原生选择器确认后注册/创建工作区 */
  createWorkspace(body: { name?: string; path?: string }): Promise<{ ok: true; root: string; slug: string }>;
  /** G14.194 原生选择标记定位(daemon 全盘找标记回绝对路径) */
  locateWorkspace(body: { token: string; roots?: string[] }): Promise<{ path: string | null }>;
  /** G14.113 分支清单/切换(欢迎页分支选择;实现体见 createConnection) */
  gitBranches(root: string): Promise<{ current: string; branches: string[] }>;
  gitCheckout(root: string, branch: string): Promise<void>;
  /** + 附加面板数据源(G12 三轮;文件区需会话——欢迎页不传 sessionId 不渲染) */
  commands(): Promise<{ commands: string[]; descriptions: Record<string, string>; supported: string[] }>;
  skillsGroups(root?: string): Promise<{
    groups: Array<{ source: string; skills: Array<{ id: string; name?: string; description?: string }> }>;
  }>;
  tree(sessionId: string, path?: string): Promise<{ entries: Array<{ name: string; kind: 'dir' | 'file' }>; truncated?: boolean }>;
  /** 缺省模型名回显(G13 反馈轮):settings model 键——欢迎页 pill 显示具体模型而非静态「default model」 */
  settings(root?: string): Promise<{
    keys: Array<{ key: string; value: string | null }>;
    providers: { choices: Array<{ id: string; model: string; effort?: string }> };
  }>;
  /** G14.121 工作区文件索引(@ 文件面板;posix 相对路径+mtime 倒序=最近改动优先);
   *  dirs=尾斜杠目录清单(@面板滤出文件夹;旧 daemon 无此字段 → undefined) */
  workspaceFiles(root: string): Promise<{ files: Array<{ path: string; mtime: number }>; dirs?: string[] }>;
  setSessionModel(id: string, model?: string): Promise<void>;
  setSessionEffort(id: string, effort?: string): Promise<void>;
  /** read-only 档建后补切(newSession mode 参数只收执行两档;见 WelcomeComposer.send) */
  setSessionMode(id: string, mode: 'read-only' | 'acceptEdits' | 'full-access' | 'plan'): Promise<void>;
}
