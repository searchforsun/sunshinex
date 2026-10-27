/**
 * md 图片语法正则单点(2026-10-27 技术债轮 D54③):`![alt](src)` 形态此前两处各写字面量——
 * 编辑卡提取(EntryViews,要 src 捕获)与刻度预览剥图(ChatRail,整段剥除)。语法若扩展
 * (如 title 段形态变化)须两处同步无锁,收编本件后只改此处。
 * 渲染面(md-render 的 img 覆写)走 react-markdown 原生解析不经正则,天然无第三份。
 */

/** 提取用(src 捕获;src 不含空白——md 链接路径含空格本就非法,编辑卡缩略图行只取合法形态) */
export const MD_IMAGE_SRC_RE = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;

/** 剥除用(整段匹配,src 允宽——预览洁净导向,非 src 提取) */
export const MD_IMAGE_STRIP_RE = /!\[[^\]]*\]\([^)]*\)/g;
