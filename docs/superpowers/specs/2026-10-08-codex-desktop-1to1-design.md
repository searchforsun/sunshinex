# Codex 桌面端美学交互 1:1 复刻 · 设计 spec

日期:2026-10-08。调研底稿:[2026-10-08-codex-desktop-audit.md](./2026-10-08-codex-desktop-audit.md)(全部数值的唯一来源,本文不重复论证,只定实现)。

用户已裁定:①accent 弃青,采纳 Codex 中性黑白 + `#339cff` 蓝仅 info/焦点/链接(推翻 G8d U-D21 青色);②用户消息改右对齐胶囊(涉 Chat.tsx);③B1 一次到位双主题。

## 0. 目标与非目标

**目标**:GUI(`gui/`)的视觉与交互语言对 Codex 桌面端 1:1——令牌、层次、形状、动效、组件形态全面对齐调研底稿 §二/§三。

**非目标(复刻纪律)**:
- **信息架构以本项目既有功能为准,不为复刻造假入口**——不加 Scheduled/Plugins 等无功能导航项;composer 的权限/模型 pill、用户消息 Edit 钮等无功能对应物的元素不做(留待功能落地时按 Codex 形态补)。
- 不动 TabStrip/Board/Files 等功能结构,只换皮到新令牌。
- 单一 CSS 文件约束(U-D10)不变:全部样式仍归 `gui/src/app.css`。

## 1. B1 令牌地基(app.css 头部重写 + index.html 主题引导)

### 1.1 主题机制

- `html[data-theme='dark'|'light']` 承载;**缺省跟随系统**:无属性时按 `prefers-color-scheme`。`gui/index.html` 增加首 paint 前内联引导(读 `localStorage['sunshinex.theme']` ∈ system|light|dark,system 则 matchMedia 定属性并挂监听)——防 FOUC。
- 令牌形态照搬 Codex 双值法:默认 `:root{}` 块即暗色值,`[data-theme='light']` 整块覆盖。不引入 `--lightningcss-*` 技巧(直接两块覆盖,可读性优先)。
- `color-scheme: dark light` 同步声明(原生控件/滚动条自适应)。

### 1.2 令牌表(全部新名,规则全面改走 token;旧名 --bg-0/--fg-0 等退役)

```css
:root { /* = dark(缺省) */
  /* 面 */
  --surface: #181818;          /* 主面板(原 --bg-0 角色,但侧栏另用 under) */
  --surface-under: #000;       /* 侧栏底(暗);亮色 #f9f9f9 */
  --surface-elevated: #212121; /* 浮层卡/菜单/composer;亮色按 elevated 系 */
  --surface-soft: #303030;     /* hover 软底(gray-300 dark) */
  --surface-code: #101010;     /* 代码块底(gray-25 dark);亮色 #fcfcfc */
  /* 字 */
  --fg: #dfdfdf;               /* 主文本(gray-fixed-150) */
  --fg-secondary: 白 70% mix;  --fg-tertiary: 白 50% mix;
  --fg-on-solid: #0d0d0d;      /* 实心钮上文字(=主面底色,对比闭环) */
  /* 边 */
  --border: 白 8%;  --border-subtle: 白 5%;  --border-strong: 白 16%;
  /* accent 与语义 */
  --accent: #339cff;           /* 蓝-300:链接/焦点环/info */
  --ok: #40c977; --warn: #ff8549; --err: #ff6764;   /* dark 档(300 系) */
  --ok-solid: #00a240; --err-solid: #e02e2a;        /* 需实心处用 500 系 */
  /* 用户消息胶囊(前景透明度制) */
  --bubble-user: 前景 5%(light)/8%(dark);
  /* 形状 ×1.25 比例尺(照 2.7) */
  --radius-xs: 5px; --radius-sm: 7.5px; --radius-md: 10px;
  --radius-lg: 12.5px; --radius-xl: 15px; --radius-2xl: 20px;
  --radius-composer: 22px; --radius-row: 9999px;
  --corner-shape: superellipse(1.5);   /* @supports 渐进 */
  /* 海拔(照 2.8 原值) */
  --elev-stroke / --elev-card / --elev-prominent / --elev-composer;
  /* 动效(照 2.9) */
  --ease-enter: cubic-bezier(.19,1,.22,1); --ease-exit: cubic-bezier(.8,0,.4,1);
  --dur-basic: .15s; --dur-relaxed: .3s;
  /* 尺度 */
  --chat-max: 800px; --thread-gutter: 16px; --sidebar-w: clamp(240px, 275px, 520px);
  --row-h: 29px; --toolbar-h: 46px;
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", menlo, consolas, "Liberation Mono", monospace;
}
[data-theme='light'] { /* 亮色整块覆盖(值见底稿 §2) */
  --surface:#fff; --surface-under:#f9f9f9; --surface-elevated:#fff(70%mix 档按需取 fixed-0);
  --fg:#1a1c1f; --fg-secondary/-tertiary 深色 70%/50% mix; --fg-on-solid:#fff;
  --border 系换深色 8/5/12%; --ok/--warn/--err 取 500/700 档(底稿 §2.5 语义映射);
  --surface-code:#fcfcfc; --elev-composer 取亮色形态;
}
```

### 1.3 全规则迁移纪律

- app.css 其余全部规则改写为只消费上述 token,**零写死色值**;`color-mix(in srgb, var(--fg) N%, transparent)` 是边框/软底的标准形态。
- 语义重排三处易错点:侧栏从 `--bg-1` 改 `--surface-under`;hover 底从实色 `--bg-2` 改 `前景5%` mix;焦点环从 `accent 2px` 改 `--accent 1.5px`。
- 滚动条:thumb = 前景 30%,hover = --border-strong。选区 `::selection` = accent 30% mix。
- 验收:全局 grep app.css 无 `#0d1117|#161b22|#30363d|#22d3ee` 等旧值残留。

### 1.4 语法高亮(hljs 令牌色改 Codex 双主题表)

`files-view` 的 hljs 类映射改底稿 §2.10 表(keyword/string/number/comment/title/name 各归 token;暗亮各一套,经主题 token 承载——新增 `--syntax-*` 七枚双值 token)。

## 2. B2 壳与侧栏

- **壳层次**:侧栏 `--surface-under`;主面板包一层 `--surface` + **左上角 `--radius-lg` 圆角**(`border-top-left-radius` + 主面盖在侧栏之上,零分割线);主面板 `overflow:hidden`。
- 侧栏宽 240px→`--sidebar-w`(275 缺省,保留既有拖拽则 clamp 对齐)。
- **胶囊行制**:组头/会话行/导航行统一 `--row-h`(29px)、`--radius-row` 胶囊、水平 padding 10px;hover = `前景5%` 填充;active = `前景8%` 填充;**竖条制(inset box-shadow accent)全废**。运行中会话:行尾 spinner(12px 旋转弧,`--dur-basic` 线性循环)替代实心点。
- 会话行 hover 浮现钮(既有 attach)形态对齐:ghost 小方钮(hover `前景5%`),非描边钮。
- 底部 Settings 行 = 普通 ghost 行(去卡片化);连接态点保留但改 6px、`--ok`/warn/灰。
- 顶条(Chat topbar):高 `--toolbar-h`,标题 13px/500,右钮 ghost 化(24px 方、hover 前景5%);去 `border-bottom`(靠主面圆角分层后顶条无需线)。
- TabStrip/右栏:tab pill 对齐 hover/active 软底制;右栏与主面间以 `--border-subtle` 0.5px 或明度差分层。

## 3. B3 会话流(Chat.tsx + CSS)

### 3.1 用户消息右对齐胶囊(DOM 改动)

- `Chat.tsx` 渲染分流:`entry.kind==='user'` → 右对齐容器(`align-self:flex-end`、max-width 80%)内气泡(`--bubble-user` 底、`--radius-composer` 22px 圆角、padding 8px 12px、13px/1.5)。气泡**下方** hover 浮现行:`复制` ghost 图标钮(clipboard 写入,成功即隐)——Codex 的 Edit 钮不做(无会话回退功能,非目标)。
- 移除现 `entry-user` 左对齐加粗形态与其 CSS;`entry-user blockquote` 平铺规则随形态退役。
- 错误/通知条目维持文档流(错误=前景8%红软底、圆角 --radius-md;通知=裸行 tertiary)。

### 3.2 日期分隔

- 线程渲染前对 entries 按日分组(本地时区,`toLocaleDateString`),组间插分隔行:居中、12px、`--fg-tertiary`、上下 16px 间距。格式对齐 Codex:`5月26日周二`(今年)含跨年加年份;**纯投影纯函数,配单测**(跨日/同年/跨年三例)。
- 条目间距:`item-gap 16px`。

### 3.3 工具行/代码块/diff/审批卡

- 工具折叠行:裸行化——13px `--fg-secondary`,图标+摘要,hover `前景5%` 胶囊;展开详情区 = `--surface-code` 底 `--radius-md` 圆角块(去现 bg-2 实底)。等宽 12px。
- 行内码:`前景8%` 底、`--radius-xs`、92% 字号;围栏块:`--surface-code` 底、`--radius-md`、无边框、12px mono、行高 1.6。
- diff 色:added=`--ok` 系/deleted=`--err-solid` 系/modified=warn 系,diff 面板底 `--surface` 94% mix 前景(Codex diff-surface 公式);DiffTab 标题/徽标对齐新令牌。
- 审批/ask 卡:浮面制——`--surface-elevated` 底 + `--elev-card` 阴影 + `--radius-xl` 圆角 + **零实线边**;approve=实心 `--ok-solid` 白字 / deny=ghost 红字 / always=ghost;标题 13px/600。
- markdown 正文对齐底稿 §2.6(p 间距 8px、标题 20px/600、引用 2px 左线 tertiary、表边 `--border-subtle`)。

## 4. B4 composer

- 容器:贴底悬浮,`--surface-elevated` 底 + `--elev-composer` 阴影 + `--radius-composer` 22px(`@supports (corner-shape: superellipse(1.5))` 时加 `corner-shape: var(--corner-shape)`);**零边框**;单行紧凑态(内容一行且未聚焦扩展)可降为胶囊 `--radius-row`——实现按内容行数切 `data-rows` 属性,过渡 `--dur-basic --ease-enter`。
- textarea:透明底无边框,行高 20px、min-height 44px、padding-inline 12px;placeholder 透明度 0.5。
- 发送/停止:**28px 圆形实心钮**——发送 = `--fg` 实心 + `--fg-on-solid` ↑ 图标;运行中变 ■(同钮位),hover = 前景8% mix 叠加。去现描边方钮。
- 布局:flex 列(输入区 + footer 行);composer 外层留 `--thread-gutter` 下边距,宽随 `--chat-max` 对齐。

## 5. B5 打磨

- 菜单/弹层(sx-menu-pop、下拉):`--surface-elevated` + `--radius-2xl` + hairline(`0 0 0 .5px --border`) + `--elev-prominent` 阴影 + backdrop-blur 16px;item = 胶囊 `--radius-lg`、hover 前景5%。
- 空态(welcome/chat-empty):居中构图——品牌符(40px,`--fg-tertiary`)+ 标题 22px/600 + 提示 13px tertiary;键位 kbd 对齐新令牌。
- 动效统一:全部 transition 走 `--dur-basic/--ease-enter`(hover/按压/浮层进出);reduced-motion 全局降级(既有 --reduced-motion 口径沿用)。
- 设置行卡式化微调(rounded-xl、行 hover 前景3%、控件 28px 高统一)。

## 6. 错误处理与降级

- `corner-shape` 不支持 = 自然回落常规圆角(@supports 包裹,零风险)。
- 主题引导脚本失败(异常 localStorage)= 缺省暗色;`matchMedia` 监听失败不影响静态渲染。
- 剪贴板写入失败(权限)= 复制钮 1.5s 显示「未复制」 tertiary 态,不弹错。

## 7. 测试与验收

- **单元**:日期分隔纯函数三例(跨日/同年/跨年);用户条目渲染快照断言(右对齐容器/气泡类/hover 行存在);主题引导纯函数(system/light/dark 三态)。
- **回归**:gui 既有 245 测试全绿(类名改动波及的断言同步修正——`entry-user` 相关用例按新形态改写,不删测试面)。
- **验收对拍**:浏览器实测截图 vs Codex 实机截图,逐批核对底稿 §四 差距表逐项闭合;视觉验收走 visual-judge 渲染页评审。
- 全量 `pnpm build` + `pnpm test` 收口。

## 8. 分批交付序

B1 → B2 → B3 → B4 → B5,每批独立可交付、可截图对拍、随批全绿测试;批间用户可随时叫停或调整下一批优先级。
