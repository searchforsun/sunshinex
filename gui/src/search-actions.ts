/**
 * 全局搜索「操作」分类条目(2026-11-21 用户裁定「所谓的快捷『操作』提示等等,不用单独点击
 * 设置页,菜单,侧栏的东西」):宿主(App)把已有动作包成可搜可执行条目注入搜索面板——
 * 打开/切换/新建全部从搜索框直达,不另造旁路语义。hint=界面既有键位(无键位不显示)。
 */
export interface SearchAction {
  readonly id: string;
  readonly en: string;
  readonly zh: string;
  /** 行尾键位提示(如 'Alt + ←');界面无键位的动作留空 */
  readonly hint?: string;
  readonly run: () => void;
}
