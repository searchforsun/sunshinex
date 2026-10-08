# Codex 桌面端 1:1 复刻 · 调研报告(审计底稿)

日期:2026-10-08。方法:**直接从本机安装的 Codex 桌面端(MSIX `OpenAI.Codex_26.1002.7124.0`)的 `app.asar` 提取渲染层全部 314 个 CSS 与主 JS bundle,取得设计令牌与组件规则的精确数值(非截图目测);并对运行中的真实窗口截图取证交互形态**。本文是复刻设计的唯一事实来源底稿。

---

## 一、来源清单

| 来源 | 路径 | 内容 |
|------|------|------|
| 主设计系统 CSS | `webview/assets/app-shared-*.css`(1.2MB) | 令牌全集(200+533+326+104 vars)、组件 token 化参数 |
| 入口/初始 CSS | `app-initial-*.css`(248KB) | composer/markdown/菜单/工具行实现规则 |
| 主 JS bundle | `app-initial-*.js`(10.9MB)+ `app-shared-*.js`(7.8MB) | i18n 文案、组件结构线索 |
| 实机截图 ×4 | 运行中的 ChatGPT.exe(Codex 壳)窗口 | 壳布局/侧栏/线程/composer/空态的真实形态 |
| 实机交互树 ×3 | accessibility tree | hover 行为、按钮清单、状态文案 |

---

## 二、设计令牌全景(精确值)

### 2.1 主题机制

`:root[data-theme=light|dark]` 双主题;`--lightningcss-light/dark` 占位变量实现单文件双值(`var(--x)` 在 light 取 A、dark 取 B)。全部颜色由「灰阶 + 品牌色阶 + 语义 token 三层」构成。

### 2.2 灰阶(暗色主题值;亮色主题为对称镜像档)

| token | dark | light | 用途 |
|-------|------|-------|------|
| gray-0 | `#0d0d0d` | `#fff` | 主面底(surface) |
| gray-25 | `#101010` | `#fcfcfc` | 代码块底 |
| gray-50 | `#131313` | `#f9f9f9` | 次面底(surface-under) |
| gray-75 | `#161616` | `#f3f3f3` | 悬停软底 |
| gray-100 | `#181818` | `#ededed` | soft 底 |
| gray-150 | `#1c1c1c` | `#dfdfdf` | — |
| gray-200 | `#212121` | `#cdcdcd` | 浮层/track |
| gray-300 | `#303030` | `#afafaf` | heavy hover/disabled |
| gray-400 | `#414141` | `#8f8f8f` | — |
| gray-500 | `#5d5d5d` | `#5d5d5d` | 固定中灰 |
| gray-600~1000 | 镜像回升 | | |

另有 `gray-fixed-*` **不随主题反转的固定档**(侧栏底、编辑器底、图表用):fixed-0 `#fff` … fixed-900 `#181818`,fixed-1000 `#0d0d0d`。

**关键结论:暗色主面板 `#181818`,侧栏(under)纯 `#000`,浮层 `#212121`;亮色主面板 `#fff`,侧栏 `#f9f9f9`。侧栏恒比主面深一档——这是 Codex 层次感的根。**

### 2.3 表面色与前景(非扩展窗口即 Electron 档)

```css
dark:  surface=#181818(gray-fixed-900)  surface-under=#000  elevated=#212121
       foreground=#dfdfdf(gray-fixed-150)  secondary=白70%mix  tertiary=白50%mix
light: surface=#fff  surface-under=#f9f9f9  elevated=#fff·70%mix
       foreground=#1a1c1f  secondary=前景70%mix  tertiary=前景50%mix
```

### 2.4 边框体系(无一条实色边框——全部为前景色透明度 mix)

```css
border-subtle = 前景色 5%   (light: 深色5% / dark: 白5%……经 color-mix)
border        = 前景色 8%   ← 默认
border-strong = 前景色 12%  (dark 16%)
hairline      = 0.5px + shadow 0 0 0 .5px 黑10%
focus ring    = blue-300 #339cff
```

### 2.5 品牌色阶(各 13 档,25→950;节选主用档)

| 色 | 25 | 300 | 400 | 500 | 700 |
|----|----|----|----|----|----|
| blue | `#f5faff` | `#339cff` | `#0285ff` | `#0169cc` | `#003f7a` |
| red | `#fff0f0` | `#ff6764` | `#fa423e` | `#e02e2a` | `#911e1b` |
| green | `#edfaf2` | `#40c977` | `#04b84c` | `#00a240` | `#00692a` |
| orange | `#fff5f0` | `#ff8549` | `#fb6a22` | `#e25507` | `#923b0f` |
| yellow | `#fffbed` | `#ffd240` | `#ffc300` | `#e0ac00` | `#916f00` |
| purple | `#f9f5fe` | `#ad7bf9` | `#924ff7` | `#8046d9` | `#532d8d` |

**语义映射**:`accent/info = blue-300 #339cff`(焦点环/链接/accent 字);success = green-500→300(dark);danger = red-500→300;warning = orange;diff added=green-500/300、deleted=red-600/400、modified=orange-700/300。**主按钮 = 前景色实心(暗色=白底黑字,亮色=黑底白字),hover = 前景色 8% mix 叠加;ghost hover = 5% 底。Codex 的「强调色」是中性黑白,蓝色只做 info/焦点/链接。**

### 2.6 字体字号

- 栈:sans = `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;mono = `ui-monospace, SFMono-Regular, "SF Mono", menlo, consolas, "Liberation Mono", monospace`
- 档:xs **11px** / sm **12px** / base **14px** / lg 16px / xl 28px;行高配对(13.3/15/21/28/49)
- **聊天正文 13px(可配 override)、代码 12px**;标题 heading-xs 16 → xl 32 全 600;UI 字重 400/500/600 + 变字体档 590
- 正文 markdown 段落 margin 8px、标题 20px semibold、引用 2px 左线 + secondary 色 + 9px 缩进、行内码 92% 字号 radius 4px surface 底

### 2.7 圆角与角形状(Codex 辨识度最高的一处)

```css
--corner-radius-scale: 1.25            ← 全部圆角 ×1.25
radius-xs .25rem→5px  sm .375rem→7.5px  md .5rem→10px
radius-lg .625rem→12.5px  xl .75rem→15px  2xl 1rem→20px  3xl 1.25rem→25px  4xl 1.5rem→30px
--codex-corner-shape: superellipse(1.5) ← 超椭圆(squircle),Electron/浏览器档启用
composer 圆角 = 22px(spacing×5.5,多行;单行=全胶囊 9999px)
导航行圆角 = 9999px(全胶囊行)
```

### 2.8 阴影/海拔(elevation)

```css
stroke        = 0 0 0 .5px border-strong
stroke-subtle = 0 0 0 .5px border-strong·4%(light)/6%(dark)
card          = 0 4px 16px #0000000d
prominent     = stroke + 0 3px 7.5px #0000000a + 0 0 20px #0000000d
sidebar       = stroke + 0 3px 7.5px #00000008 + 0 0 16px #00000005
composer      = 0 0 0 1px #0000000a, 0 2px 8px #0000000a, 0 4px 80px 8px #00000006
composer-dark = inset 0 0 1px 0 #ffffff33
menu          = hairline 描边 + xl 阴影 + backdrop blur(16px)
```

### 2.9 布局尺度

```
聊天内容最大宽 800px;thread 左右 gutter 16px;composer gutter 12px
条目间距 item-gap 16px / 同组紧排 4px
侧栏宽 clamp(240px, 275px, min(520px, 100vw-320px))
导航行高 29px(padding-y 4px × 13px×1.5);工具栏 46px;标题栏 44px
composer:行高 20px、min-height 44px、占位符透明度 0.5、发送钮 28px 圆
menu:item radius-xl、item bg=前景5% hover、gutter 4px;tooltip 字号 12px
scrollbar:thumb = 前景色 30%,hover = border-strong
动效:enter cubic-bezier(.19,1,.22,1) / exit (.8,0,.4,1) / 基础 .15s、放松 .3s
     streaming 文本 .7s;pulsing dot 1.25s ease-in-out infinite
```

### 2.10 语法高亮(Codex 双主题各一套)

| token | light | dark |
|-------|-------|------|
| comment | `#4f4f4f` | `#b9b9b9` |
| keyword | `#ab4f7a` | `#f8a6c8` |
| literal/number | `#ac4f23` | `#f1a275` |
| string | `#3a843f` | `#83d197` |
| variable | `#643cae` | `#b897f4` |
| attribute/attr | `#b8802b` | `#f9dc78` |
| name/function | `#1f4e94` | `#63a8f8` |
| error | red-600 | red-200 |

代码块底:`gray-25`(light `#fcfcfc` / dark `#101010`);行内码底 `surface-secondary`。

---

## 三、组件级细节(截图 + a11y 树 + CSS 互证)

### 3.1 壳(Shell)

- 原生标题栏 44px(应用菜单 File/Edit/View/Help);内容区侧栏黑、主面板**左上角 radius-lg(12.5px)大圆角**压在侧栏之上形成浮层感(主面 = elevated 浮层,侧栏 = under 底)
- 主区顶条 46px:左=会话标题(14px 500);右=`…`更多 / diff面板钮 / 右侧板 toggle,均为 ghost 图标钮(hover 5% 底)
- 侧栏宽 275px 缺省;与主面之间**零分割线**(靠明度差分层)

### 3.2 侧栏

- 结构:顶部「Codex ˅」模式切换(可切 ChatGPT/Codex)+ 右上搜索 icon;导航项 New chat/Scheduled/Plugins/Explore(icon+label,29px 胶囊行);分组头 Projects/Recents(12px 600);会话行;底部 Settings 行
- 行为:行 hover=前景5%填充胶囊;active=填充;**运行中会话行右侧转圈 spinner**;会话行 hover 浮现 Archive/Pin 两枚 ghost 小钮;空分组灰字(「No projects」斜体感灰)
- 底部 Settings = 普通 ghost 行,非卡片

### 3.3 会话线程(文档流)

- 顶部日期分隔:**居中、tertiary 灰、12px**「5月26日周二 at 21:30」
- **用户消息 = 右对齐紧凑胶囊**:前景色 5% 底(light)/8%(dark)、22px 内边距紧凑、圆角胶囊;**hover 时气泡下方浮现 Copy / Edit 两枚幽灵小图标**
- assistant 正文 = 无框文档流 13px;"You said:" 引用上下文
- 活动行:「Thinking」等 = tertiary 灰 12-13px 裸行;工具/命令行 = 弱化折叠行(`ExpandableEntry` 模式);错误 = 软红底行
- 加载 shimmer(pulsing dot / LoadingResultsShimmer)

### 3.4 Composer(浮卡输入)

- surface = elevated-secondary;阴影 = `elevation-composer`;圆角 22px + superellipse;**零边框**(单行态=全胶囊)
- 输入区行高 20px、min-height 44px、padding-inline 12px;占位符 50% 透明度
- footer:左 `+`(Add files and more)、**盾牌 icon「Ask for approval」权限选择**(菜单);右侧**模型选择「5.5 Medium ˅」**+ **28px 圆形实心发送钮**(运行中变 ■ stop,底=前景色实心/icon 反色)
- 模式激活时 composer 外圈 1px mode 色描边
- home 态:composer 上方另有「Choose project」浮条(同一浮面簇)

### 3.5 空态 / 审批 / 菜单

- 空态:居中 OpenAI 花logo(48px 灰)+「What should we build?」22-28px 600 标题;composer 居中悬浮
- 审批:i18n 证实「Awaiting approval」「Approval options」「Approved」卡;权限下拉三态 Ask for approval / Auto 等(未截到实卡,复刻时按卡式浮面 + 权限色系处理)
- 菜单/浮层:radius 2xl(20px)、elevated-secondary 底、hairline+xl 阴影+blur;item radius-xl、hover=前景5%;tooltip 双型(compact 黑底 / classic 白底 hairline)

---

## 四、与本项目 GUI 的差距映射

现状(`gui/src/app.css`,752 行,G8f 迭代二后):GitHub-dark 色板(`#0d1117` 系)+ **青色 accent**(G8d U-D21 用户裁定)+ 实色边框(`#30363d`)+ 10px 圆角 + 仅暗色。G8f 已对齐:会话流去盒化、侧栏 pill 雏形、composer 浮卡雏形、设置卡式化。

| # | 细节 | Codex 现状 | 本项目现状 | 差距动作 |
|---|------|-----------|-----------|---------|
| 1 | 灰阶底色 | `#181818` 主面 / 纯黑侧栏 / `#212121` 浮层 | `#0d1117`/`#161b22`/`#21262d`(偏蓝) | **令牌层整体替换** |
| 2 | 边框 | 前景色 5/8/12% mix,几乎不可见 | 实色 `#30363d` 全量 | 改透明度 mix 制 |
| 3 | accent | 中性黑白主钮 + blue-300 info/焦点 | 青色 `#22d3ee` 全量 | **待用户裁定(见 §六)** |
| 4 | 圆角 | ×1.25 scale(10/12.5/15/20px)+ superellipse + composer 22px | 统一 10px/8px | 换比例尺;superellipse 渐进增强 |
| 5 | 主题 | 双主题全量 | 仅暗色 | 新增 data-theme 亮色整套 |
| 6 | 侧栏层次 | 恒深一档 + 主面左上大圆角浮层感 | 同为 bg-1 + 实线分割 | 黑底 + 主面圆角 + 去分割线 |
| 7 | 用户消息 | 右对齐 5% 底胶囊 + hover copy/edit | 左 accent 竖条 → G8f 无框加粗 | DOM 改右对齐胶囊(**待裁定**) |
| 8 | 日期分隔 | 居中灰小字 | 无 | 新增渲染 |
| 9 | composer | 浮卡 22px 超椭圆 + elevation 阴影 + 28px 圆发送钮 + 权限/模型 pill | 浮卡雏形 12px 圆 + 方发送钮 | 补齐形状/阴影/按钮形态 |
| 10 | 代码块 | gray-25 底 + md 圆角 + 双主题语法色 | bg-0 + 实线边 + hljs 自配青绿色 | 换底色 + 换语法色表 |
| 11 | 行内码 | surface-secondary 底 4px 圆 | bg-2 底 | 微调 |
| 12 | 审批/ask 卡 | 卡式浮面 + 权限色系 | warn/accent 实线边框卡 | 按浮面制重做 |
| 13 | 菜单/弹层 | 20px 圆 + blur + hairline + item xl 圆 | 10px 圆实线边 | 换浮面制 |
| 14 | 滚动条 | 前景 30% 细条 | border 实色 8px | 换透明度制 |
| 15 | 动效 | enter(.19,1,.22,1)/.15s 体系 | 零散 0.12-0.15s ease | 统一曲线 token |
| 16 | 焦点环 | blue-300 | accent 2px outline | 随 #3 联动 |
| 17 | 空态 | logo + 大标题居中 | 品牌字 + 提示(已有) | 构图对齐 |
| 18 | 运行中指示 | 侧栏行 spinner + stop 圆钮 | accent 实心点 + 方 stop 钮 | 形态对齐 |

---

## 五、建议复刻分批(供 spec 展开)

- **B1 令牌地基**:app.css 头部令牌段重写为 Codex 双主题令牌表(§二全量迁入,`data-theme` + `prefers-color-scheme` 缺省),全组件规则改走新令牌;青→(裁定色);滚动条/焦点环/selection 随批。此批落地=全应用底色即 Codex。
- **B2 壳与侧栏**:黑底侧栏、29px 胶囊行(hover 填充/active 填充/运行 spinner/hover 浮钮)、组头、Settings 行;主面左上大圆角与层次、去分割线;顶条极简。
- **B3 会话流**:日期分隔、用户消息右胶囊(+hover 浮钮,涉 Chat.tsx)、活动/工具弱化行细化、代码块/行内码/语法色/diff 色对齐、审批卡浮面化。
- **B4 composer**:浮卡 22px(+superellipse 渐进)、elevation-composer 阴影、占位 50%、+ 钮与权限 pill、模型 pill、28px 圆发送钮(运行=stop)。
- **B5 打磨**:菜单/弹层/tooltip 浮面制、空态构图、动效曲线统一、reduced-motion。

测试口径:gui 现有 245 测试全绿跟随;视觉验收走渲染截图对拍。

---

## 六、待用户裁定(阻塞项)

1. **accent 身份**:Codex 真身 = 中性黑白主按钮 + `#339cff` 蓝仅作 info/焦点/链接;本项目 G8d 曾裁定青色 accent(贯穿会话点/徽标/按钮/链接)。1:1 复刻 → 建议弃青从中性+蓝;保留青则 composer 主钮/焦点环等处与 Codex 形似神不似。
2. **用户消息形态**:Codex = 右对齐胶囊(交互语义:用户说话在右,如 IM);需改 Chat.tsx 渲染结构。1:1 → 改。
3. **亮色主题批次**:双主题是令牌地基的一部分(B1 一次到位,成本主要在规则全部走 token 的纪律);亦可先暗色后亮色分两批。
