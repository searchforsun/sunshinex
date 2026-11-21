# 通道层（channels）架构设计 —— 任意 IM 平台 ↔ sunshine 会话

> 状态：设计稿（2026-11-21 调研后成文）。sunshine 定位通用智能体，本层目标是**任何外部 IM 平台
> （飞书/钉钉/企业微信/微信公众号/Telegram/Discord/Slack…）都能成为 sunshine 会话的入口与出口**，
> 且新增一个平台 = 新增一个适配器，核心零改动。

## 0. 调研结论（设计依据）

- **HERMES Agent / OpenClaw**（同品类先例）：常驻 gateway 进程 + channels 适配器层，多数通道走
  **出站连接**（WhatsApp WS 会话、Telegram 长轮询），自托管无需公网。两者的国内平台支持（微信/飞书/
  钉钉/企微）反而是短板——全靠社区桥接。
- **chatgpt-on-wechat / LangBot**：渠道—插件—模型三层解耦，channel 适配器模式是本品类通行做法。
- **CodeBuddy Code `/remote-control`**（编码智能体接企微智能机器人，同类产品最完整先例）：
  WS 长连接（`wss://openws.work.weixin.qq.com`）+ 流式占位气泡（同 `stream.id` 帧全量替换）+
  审批投票卡（失败回退文字 y/n）+ 群聊仅响应 @ + 超时降级异步推送。
- **平台官方能力（关键）**：飞书（自建应用事件订阅长连接）、钉钉（Stream 模式）、企微（智能机器人
  API 模式 WS 长连接，2025 起）**全部支持客户端主动外连的长连接，无需公网 IP/域名/内网穿透**。
  例外：微信公众号（HTTP 回调需公网）、微信个人号（无官方 API，非官方协议有封号风险，不接入）。

**对本项目最重要的一条**：出站长连接模式下，通道引擎是「主动外连」的客户端——sunshine serve
恒绑 `127.0.0.1`（§4.3 裁定，远程暴露为 v1 非目标）的安全模型**完全不用动**。

## 1. 总体形态裁定

三个候选形态：

| 形态 | 说明 | 裁定 |
|---|---|---|
| **A. daemon 内子系统**（`src/serve/channels/`，与 `src/serve/schedules/` 平行） | 引擎活在与会话注册表同进程内，直接调 `createSession/getSession/attach`，直接订阅帧流 | **✅ 采用** |
| B. 独立网关进程 | 纯客户端姿态连 `sunshinex serve`（复用 `gui/src/connection.ts`） | 备选。改动最小但要自管会话映射/生命周期/serve-token 发现，且跨进程事件订阅（WS 客户端姿态）比进程内订阅更重 |
| C. 插件 | 承载出站工具 | 插件协议只能贡献模型外呼的 MCP 工具（`docs/PLUGIN-DEV.md` §1），**承载不了入站消息**（无反向注册 HTTP 端点/监听器的通道）——只用于第 6 节的出站备选 |

裁定 A 的理由：
1. **schedules 是现成模板**——「外部事件驱动会话」的完整先例（store/engine/executor/handlers/model
   五件套 + daemon 装配 + io 注入），通道层逐字同构：trigger 从「到点」换成「IM 消息到达」。
2. 进程内直调会话面：`submit/steer/onRunEnd`、帧订阅、挂起回执、meta 写入全部同进程可达，无协议层。
3. 生命周期归属 daemon（`start()` 布防 / `teardown()` 先收），teardown 序里引擎停外连先于网络面收口，
   语义与 scheduleEngine.stop() 完全一致。

## 2. 目录与 daemon 装配

```
src/serve/channels/
  model.ts        # 类型 + 校验：ChannelConfig / Binding / InboundMessage / OutboundMessage / DeliveryCaps
  store.ts        # bindings 运行时档落盘：channels-bindings.json（userConfigDir，SUNSHINEX_DATA_DIR
                  # 重定向——schedulesFile 同款；坏档隔离 quarantine 同 ScheduleStore）
  engine.ts       # 生命周期：start() 按启用通道逐适配器 dial；stop() 全停；健康态外窥
  router.ts       # 入站管线（平台无关核心，见 §4）：去重→准入→指令→绑定→submit/steer→ack
  reply.ts        # 出站管线（平台无关核心，见 §5）：帧订阅投影→投递；onRunEnd 兜底
  handlers.ts     # HTTP 运维面：/channels 健康快照/连接测试/绑定管理（配置 CRUD 走 settings 键，见 §4 存储总览）
  adapters/
    types.ts      # ChannelAdapter SPI（§3）
    dingtalk.ts   # 钉钉 Stream（dingtalk-stream npm）
    feishu.ts     # 飞书长连接（@larksuiteoapi/node-sdk WSClient）
    wecom.ts      # 企微智能机器人 WS 长连接（自研 ws 客户端，协议见 §10）
    telegram.ts   # Telegram long polling（实现量最小，作 SPI 中立性样板/测试夹具）
    mock.ts       # 测试夹具（内存适配器，单测/e2e 用——schedules 测试口径）
src/config/channels.ts  # settings.json `channels` 语义键装载（providers.ts 模板：形状裁决单点，§4）
```

daemon 装配点（全部有 schedules 先例可抄）：

- 构造器（daemon.ts:216 schedules 先例 ：224-234）：`new ChannelsStore(...)` + `new ChannelsEngine(io, store)`
  + `new ChannelRouter(...)` + `new ReplyProjector(...)`。io 注入：
  ```ts
  interface ChannelsEngineIo {
    // —— 与 ScheduleExecutorIo（executor.ts:13-19）同面 ——
    createSession(root: string, opts?: CreateSessionOpts): Result<{ sessionId: string }>;
    getSession(id: string): SessionRuntime | undefined;
    attach(id: string): Result<{ sessionId: string }>;      // 重启后按 journalId 重开（daemon.attach）
    releaseSession(id: string): void;
    activeSessionId(): string | undefined;
    // —— 通道层新增两面对 ——
    onFrame(cb: (frame: DaemonFrame) => void): () => void;  // 进程内帧订阅（§5，改动面见 §7.1）
    sendChannelMessage(msg: OutboundMessage): Promise<void>; // send_channel_message 工具 seam（§6）
  }
  ```
- `start()`（daemon.ts:420，scheduleEngine.start() :495 之后）：`this.channelsEngine.start()`——
  适配器主动外连，HTTP/WS 面就绪与否不影响（长连接不依赖入站监听）。
- `teardown()`（daemon.ts:532，`this.scheduleEngine.stop()` :533 同位）：`this.channelsEngine.stop()`——
  先停外连，再走既有收口序。
- 路由表（daemon.ts:612）：
  - 配置 CRUD/启停走 **`GET|PUT /settings/channels` 结构化键写面**（同 `/settings/plugins` :987-988
    先例——settings 语义键的 HTTP 读写既有路径，RawPane/搜索直达/config-changed 全部免费继承）；
  - `/channels` 只留运行时运维面（auth:true）：GET `/channels`（健康快照）、POST `/channels/:id/test`
    （连接测试）、GET/DELETE `/channels/bindings`（绑定管理）、GET `/channels/sessions`（通道域会话
    枚举——扫 channels 容器各域 listSessions 归并，`GET /sunx/sessions` 同构，侧栏「通道」组数据源 §9）；
  - webhook 形态通道的回调端点（auth:false + 适配器自验签，`/healthz` :613 先例；v1 仅长连接
    形态，webhook 留 §10 P3）。

## 3. 平台适配器 SPI（唯一每平台一变的接口）

```ts
/** 入站规范化消息：各平台载荷 → 单一形状。raw 保留平台原始载荷供适配器级排障，核心不读。 */
interface InboundMessage {
  channel: string;            // 适配器 id（'dingtalk' | 'feishu' | ...）
  chatId: string;             // 平台会话标识（单聊 cid / 群聊 chatid）
  chatKind: 'direct' | 'group';
  userId: string;             // 平台用户标识（staffId/openid/...）
  userDisplay?: string;       // 发送者显示名（适配器入站顺手带；群聊定向回复/消息前缀用）
  msgId: string;              // 平台消息 id——幂等去重键（平台重推/长连接重放）
  text?: string;
  images?: string[];          // 规范化为本地文件路径/dataURL——直喂 SessionRuntime.submit images 参
  atBot?: boolean;            // 群聊 @ 机器人在场（群聊准入判据）
  raw: unknown;
}

/** 出站投递能力：router 按 caps 协商降级链，适配器声明自己的上限。 */
interface DeliveryCaps {
  streaming: boolean;         // 支持同气泡替换（企微 respond_msg / 飞书卡片更新）
  markdown: boolean;
  card: boolean;              // 卡片（审批/提问面用，§5.3）
  maxTextLength: number;      // 超长自动分片
}

/** 适配器 SPI：一个平台实现一个类。长连接形态 = start() 内主动外连。 */
interface ChannelAdapter {
  readonly id: string;
  caps(): DeliveryCaps;
  /** 挂载并开始外连；入站消息经 sink 上抛（引擎负责串行投递给 router）。幂等：stop 后可再 start。 */
  start(sink: (msg: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  /** 状态外窥（管理面/诊断）。 */
  health(): { connected: boolean; detail?: string };
  /** 主动推送（新气泡/新消息）——回复终稿、失败通知、send_channel_message 工具走这里。 */
  send(target: ChatRef, msg: OutboundMessage): Promise<void>;
  /** 回执式回复（可选）：平台提供 req_id/webhook 语义时实现（企微 respond_msg 占位等）。
   *  未实现时 router 回退到 send。 */
  reply?(inbound: InboundMessage, msg: OutboundMessage): Promise<void>;
  /** 流式替换（可选）：同气泡更新。未实现时 router 走分段 send 降级链。 */
  stream?(target: ChatRef, ref: StreamRef, delta: StreamDelta): Promise<void>;
}
```

设计要点：
- **降级链在 router 不在适配器**：`流式→分段 send→终稿 send`、`markdown→纯文本`、`卡片→文字 y/n`
  （CodeBuddy 的卡片失败回退文字同思路）。适配器只声明 caps + 实现（必选 send；可选 reply/stream），
  router 统一编排——新平台实现量被压到最小。
- **图片双通道**：入站 `images` 规范化后直喂 `submit(goal, images)`（session.ts:1438 已有 images 参，
  spillImages 落盘链现成）；出站 `OutboundMessage.attachments` 由适配器自行上传平台文件接口。
- **幂等在引擎/router 不在适配器**：`msgId` 去重表（LRU）由 router 统一维护。
- **定向回复（群聊 @ 指定人，2026-11-21 用户裁定）**：入站带 `userDisplay`（发送者显示名，适配器
  入站时顺手取——telegram `from.first_name`、飞书/钉钉事件载荷 sender 名）；出站统一走「文本前缀
  `@display`」由引擎包装（engine 每 binding 记最近触发发送者——**谁触发这一轮，回复就 @ 谁**）；
  平台原生语义（telegram `reply_to_message_id`、飞书 `im.message.reply`、钉钉 at 结构）留作适配器
  增强，P0 统一前缀档，不写平台分支。

## 4. 入站管线（router.ts，平台无关）

```
InboundMessage → [msgId 去重] → [准入校验] → [指令解析] → [绑定解析] → [submit / steer] → [ack]
```

1. **去重**：`channel:msgId` LRU 集（如 4096 条），命中即丢弃。
2. **准入**（§5.2 安全模型）：allowlist 未命中 → 静默丢弃或提示（可配）；群聊且 `!atBot` → 丢弃。
3. **指令解析**：`/new`、`/stop`、`/status`、`/mode`、`/help` 等**在 router 层短路处理，不进模型**。
   v1 最小集：`/new`（**同聊天内**新建会话并重绑——binding 覆写指向新 sessionId/journalId，
   `lockedUserId`/`rootOverride` 等绑定元数据保留；旧 runtime 释放、journal 留盘可回看，
   同域 `data/sessions/` 下多条会话记录共存）、`/stop`（interrupt）、`/help`。
4. **绑定解析**：`bindings` 表按 `channel:chatId` 查绑定：
   - 有绑定且运行时在座 → 直接用；
   - 有绑定但 daemon 重启过（运行时不在注册表）→ `io.attach(journalId)` 重开（schedules 记录
     「journal 留盘可重建」同语义）；
   - 无绑定 → **root 解析**：`cfg.root === 'auto'`（缺省）→ 铸造**聊天专属域**（两级，**data 与
     工作区平级、不嵌套**）：
     `<channelsContainerDir()>/im-<channelSlug>-<chatSlug>/{workspace,data}`——容器
     `~/.sunshinex/channels/`（SUNSHINEX_CHANNELS_DIR 覆盖，sunxContainerDir 同款惯例；
     `src/slug.ts` slugify 单点规则；mkdir 幂等）。**createSession 的 root = `<域>/workspace`**
     （agent 工作目录，任务文件产出落这里）；`resolveDataDir` 增分支：root 位于 channels 容器内 →
     dataDir = `<域>/data`（容器内首段即域目录；否则仍走 projectsRoot slug 常规路径）。**data 平级
     隔离的裁定**（2026-11-21 用户：data 不得嵌在工作区内——full-access 的 agent 不得能一脚踩碎
     自己的会话账本；常规项目 root 与 data 异树、sunx 域是纯持久化域，均无此问题，channels 不做
     嵌套形态）。**严格三分容器**（channels 独立容器，不混居 projects——与 sunx 对称；代价 =
     专用枚举面 + 侧栏专属分组，见 §9）。目录爆炸面由准入管住（first-user=每通道 1 个聊天，
     list=人工名单）。显式配置真实项目 root = 高级用法（配合 mode 收窄）。
     → `createSession(root, { activate: false, mode, model })` + `writeSessionMeta`
     （`channel: 'feishu'` 标记，侧栏图标同 `scheduled: true` 先例，§7.4）。
5. **提交分派**（G3 双态，与 GUI use-chat-submit 同口径）：
   - `session.status() === 'idle'` → `session.submit(text, images)`（**群聊提交注入发送者前缀**
     `[来自 ${userDisplay}]: ${text}`——多人群聊上下文可归因；单聊不加，一会话一人）——IM 消息就是**普通用户提交**
     （markUserActivity 路径，不新增 submit wake 形态——唤醒轮是「无人驱动」语义，IM 有真人在场，
     不得混入 wake 词汇/唤醒预算）；
   - `running` → `session.steer(text, images)`——运行中插话排队，步边界注入，恒受理。
   - `submit` 409（单 run 锁竞态，提交后立刻再发）→ 回退 steer。
6. **ack**：受理即回执（`reply()` 或 `send()`）：「已受理，正在处理」（运行中则「已加入排队（第 N 条）」）。
   长连接形态无平台侧 ack 时限，但首字节延迟是体验线——ack 恒即时。

**存储总览（三处，各归其位——2026-11-21 用户裁定「设置页内容直接放 settings」）：**

1. **声明性通道配置 → 全局 settings.json `channels` 结构化语义键**。装载走 `src/config/channels.ts`
   （`config/providers.ts` 模板：结构化键形状裁决单点、非法条目 warning 跳过不致命、不经 flatten/env
   槽）；设置页读写的就是这个键——SettingsForm/RawPane/config-changed/搜索直达全部免费继承。
   **项目级整键忽略（全局豁免）**：providers 键允许项目级遮蔽，channels 不行——通道是 daemon
   主动外连的执行面，项目档若能定义通道，等于克隆一个仓库就能注入「外连攻击者机器人 +
   full-access 会话」的供应链攻击面。SettingsShell 对本 pane 不下发 root/scope（ProvidersPane
   「提供方页即全局」先例）。
2. **凭证 → env 槽（D6 用户裁决「env 块只承载敏感字段」「设置与凭据分离」延续）**：
   `channels` 键里**没有任何密钥字段**；每个通道按名取
   `SUNSHINEX_CHANNEL_SECRET_<大写通道名>`（`providerApiKeyEnv` 同派生规则，providers.ts:40），
   settings env 块或真实环境变量皆可；适配器 start 时解析，缺失=该通道拒绝启用（fail-closed）。
   设置页凭证行写 env 块键（ProvidersPane 密钥行同机制）。
3. **会话映射（运行时状态）→ `<userConfigDir>/channels-bindings.json`**：router 自动维护、用户不碰，
   不进 settings（settings 是用户手写的声明，运行时高频改写会污染档面 + 触发 config-changed 回声）。

settings.json `channels` 键形状（零密钥）：

```jsonc
"channels": [
  { "id": "feishu-main", "platform": "feishu", "enabled": true,
    "root": "auto",                 // 'auto'=聊天专属工作区（缺省，§4 绑定解析）；显式路径=绑定真实项目（高级）
    "mode": "read-only",            // 该通道建会话的权限模式——安全缺省（§5.3）
    "model": undefined,             // undefined=跟随全局默认
    "allow": { "kind": "first-user" } // 仅首次对话用户 | { "kind": "list", "userIds": [...], "chatIds": [...] } | { "kind": "all" }
  }
]
```

`channels-bindings.json`（StoreFile v1，router 独享写者）：

```jsonc
{
  "version": 1,
  "bindings": [
    { "key": "feishu-main:oc_yyy", "sessionId": "s7", "journalId": "j3",
      "lockedUserId": "ou_xxx",     // allow.kind='first-user' 时首聊锁定
      "rootOverride": undefined,    // §9.3 聊天信息条「绑定工作区切换」写入；下次 /new 生效
      "updatedAt": 1763700000000 }
  ]
}
```

## 5. 出站管线（reply.ts，平台无关）

### 5.1 帧订阅投影

`RunEndInfo`（session.ts:141）只带终态不带回复文本——**回复内容从帧流投影**。daemon 的
`broadcastFrame`（daemon.ts:412 → WsHub.broadcastFrame）是全帧单点：在 daemon 侧加进程内订阅者
注册（§7.1），`ReplyProjector` 按 sessionId 过滤本通道绑定会话的帧：

- **流式路径**（adapter.stream 在场）：投影 assistant 文本帧增量 → 同气泡替换
  （CodeBuddy：同 `stream.id` 帧全量替换当前气泡，段间新气泡）。
- **分段路径**（仅 send）：按段落/阈值聚合，超 `maxTextLength` 分片。
- **终稿兜底**：`session.onRunEnd`（session.ts:1421，**一次性观察者**——executor.ts:104「每轮注册」
  同款，每轮提交后重新注册）在收尾时投递终稿 + 终态注记（失败/中断附 stopReason——schedules
  finish 的 status 映射同构 ：123）。
- **定向回复**：投递前缀 `@<lastSender>`（engine 每 binding 记最近触发发送者，router 每次入站经
  `noteSender` 回写——群聊回复回给 @ 机器人的那个人；display 缺失不加前缀；streaming 全量替换帧
  不加前缀，分段/终稿 deliver 加）。

### 5.2 审批 / 提问面映射

会话挂起帧（approval/ask/plan-approval，daemon 挂起表 + 挂起帧重发面）投影到通道：

- `caps.card` 在场 → 投票卡/按钮卡；点选 → 调既有回执路径（`resolvePending…` / POST `/approval/:pid`
  同款 daemon 方法）。
- 无卡片 → 文本回退：「[审批] xxx，回复 y/n」（CodeBuddy 回退语义）。
- **这是 IM 用 sunshine 的关键体验**：权限确认不回 IM 会被无限期挂起——投影必须覆盖挂起帧
  （WS 连接建立即补发挂起帧的先例，daemon-ws.ts:143）。

### 5.3 安全模型

- **准入是第一道闸**：IM 机器人天然「任何人可发消息」——allowlist（userId/chatId）是硬前置，
  未配置 allow 的通道不启用（fail-closed）。群聊仅 @ 触发。
- **权限模式缺省 read-only**：通道配置的 `mode` 是该通道建会话的权限模式；跨通道驱动
  full-access 的 sunshine 是本特性最大风险面，缺省收窄、用户显式放开。
- **凭证分离（D6 口径）**：密钥只走 env 槽（`SUNSHINEX_CHANNEL_SECRET_<名>`），settings 语义键与
  凭据分离——channels 键零密钥，settings.json 不因通道新增暴露面；GUI 展示脱敏（`••••`+尾 4）。
- **channels 键全局豁免**：项目级整键忽略（§4 存储总览 1）——克隆仓库不得借项目档注入外连目标。
- **userConfigDir 白名单围栏（2026-11-21 用户裁定「好好盘一下」：不影响应用运行的内容性目录
  放行，方便 agent 协助修改）**：agent 写族在 `~/.sunshinex/` 内**仅白名单放行，其余一律恒拒**
  （硬底线：full-access 不放行、用户 allow 不可放宽——产品硬底线先于用户规则）。白名单均为
  内容性目录，写坏不伤应用运行：

  | 白名单 | 内容 | 来源 |
  |---|---|---|
  | 自 `<dataDir>/skills/**` | 学习技能写入面 | 既有窄口（skills.ts:37） |
  | 自 `<dataDir>/memory/**` | 记忆 | 既有窄口（memoryWriteAllowed） |
  | `~/.sunshinex/skills/**` | 用户级技能库 | 本轮新放行（原保守裁定不放行，按「协助修改」口径升级） |
  | `~/.sunshinex/agents/**` | 智能体全局目录 | 本轮新放行；项目级 `<root>/.sunshinex/agents` 随 root 信任域天然可写 |
  | `~/.sunshinex/teams/**` | 预定义智能体团队（team.md 用户级根，userTeamsDir） | 本轮新放行（与 agents 同性质——用户手写内容，协助建团队/改章程；**会话级 `<dataDir>/teams/<journalId>/` 板面运行态不在此列**，仍随 dataDir 围栏只读） |
  | `~/.sunshinex/SUNSHINE.md` | 全局规范单档 | 本轮新放行（品性高影响面，纯内容、可回改） |

  **恒拒采样（白名单外全部恒拒，fail-closed 防漏）**：settings.json（既有两级硬保护）、
  mcp.json（MCP 注入面）、serve-token（凭证；读面收紧列后续增强）、schedules.json（引擎独占档，
  agent 建任务走 create_scheduled_task 工具为合法通道）、channels-bindings.json（router 独享）、
  pty-replay/**、gui/**（应用私有态）、plugins/**（**篡改 = 下次装配任意代码执行**，
  最高敏）、projects/*/data/**、sunx/*/data/**、channels/*/data/**——**三容器 data 只读成为
  白名单围栏的自然子集，不再单列条款**；自 dataDir 的 skills/memory 两窄口在更早求值已放行
  （白名单判定不覆盖 dataDir 子树内路径，避免双判）。读不设限照旧（只拦写族 WRITE_TOOL_NAMES）。

  落点：chain.ts 写分支——`inUserConfig && !whitelisted → 恒拒` 置于硬底线区（settings.json/.git
  邻位，先于 worktree 拒写/用户规则），**取代 `inUserConfig` 整根直放**（现序正是洞：整根放行
  先于数据只读，缺省布局下三容器 data 实际可写）。root 族信任域放行不变（工作区内容本就
  agent 可写）。landlock 可写根收敛（:324 现含 `~/.sunshinex` 整根）列为增强，工具层守卫为准。
- **命令面最小化**：router 指令不提供模式提权外的会话操作；`/mode` 提权仅 allowlist 用户可用。

## 6. 主动外呼：`send_channel_message` 工具（模型可调）

让模型在会话中主动向 IM 发消息（任务中途汇报、跨通道通知）。两条路：

| 路 | 说明 | 裁定 |
|---|---|---|
| **builtin 工具 + daemon seam** | 同 `create_scheduled_task` → `scheduleCreateSeam`（daemon.ts:277，lifecycleIo 注入 session/runtime.ts）先例：harness 内置工具经 seam 调 daemon 面 | **✅ 采用**——免插件进程、免费获得 safety 审批声明体系、与通道引擎同进程直连 |
| MCP 插件 | `channels-send` 插件（browser-use 模式），子进程内 HTTP 连 daemon（读 serve-token） | 备选。仅当未来要把通道能力开放给第三方扩展时再走 |

seam 形状：`channelSendSeam: { send(channelId, chatId, text): Promise<Result<void>> }`，注入
lifecycleIo，工具面 `send_channel_message(channel?, chat_id, text)`（channel 缺省=本会话绑定的通道，
由 SessionRuntime 持有 binding 上下文回填）。

## 7. 现有代码改动面清单（全部小刀口）

1. **daemon 帧订阅 seam**：`GuiDaemon.broadcastFrame`（daemon.ts:412）旁挂本地订阅者数组 +
   `onFrame(cb): () => void`；WsHub 零改动（订阅在 daemon 层，hub 只管 WS 客户端）。
2. **lifecycleIo 加 `channelSendSeam`**（scheduleCreateSeam :270 同位）。
3. **路由表加 `/settings/channels`（GET|PUT，结构化键写面）+ `/channels` 运维面**（:612 表内追加，
   handlers.ts 模式同 schedules/handlers.ts；分工见 §2 路由表条目）。
4. **会话 meta `channel` 标记**：`writeSessionMeta` 增可选 `channel: string`——侧栏会话行挂通道图标
   （`scheduled: true` 钟面先例，2026-11-21 同款路径）。GUI 侧栏消费是独立小任务，可后置。
5. **`GET /sessions` 系列透出 channel 标**（同 scheduled 布尔透出先例）。
6. **设置页通道 pane**（§8 全节）：`settings-groups.ts` 基础组注册 + `SettingsShell.tsx` renderPane
   分发（全局形态）+ `ChannelsPaneConn` 并入 `SettingsShellConn`（`gui/src/connection.ts`/
   `connection-api.ts` 加 channels 族端点封装）+ `settings-search.ts` 条目
   （config-changed 复用既有 settings resource tick，无新增 resource）。
7. **侧栏「通道」分组 + Chat 聊天信息条**（§9 全节）：`resolveDataDir` channels 容器分支 +
   `GET /channels/sessions` 枚举面 + `ChannelsSection`/`use-menu-channels`（project-menu-sunx 先例）
   + Chat 通道信息条（绑定信息展示 + rootOverride/解绑两可编辑项）。

不动的：session/kernel/steer 语义（零新增 submit 形态）、回环绑定与鉴权模型（出站长连接不触）、
WS 协议、GUI 会话数据流（Chat.tsx 链路）。

## 8. GUI 设置页：每通道一个配置组

通道配置入口 = 设置页新增「通道」导航项（`settings-groups.ts` 基础组，恒显——通道与「模型与提供方」
同级，是连接性配置不是开发者高级项）。面板形态走 **ProvidersPane 先例：全局资源页**——数据源 =
settings.json 全局 `channels` 结构化语义键（§4 存储总览），读写走 `GET|PUT /settings/channels`
（`/settings/plugins` :987 先例），不分项目作用域，壳不下发 scope 五件套
（SettingsShell.tsx renderPane ProvidersPane 分支同款；卡内「工作区」字段自己消费
`conn.workspaces()` 下拉）。组件全部用设置共享原语（TeamsPane 先例）：`ResourceCard` 卡列表 +
`Switch` 启停 + `ScopeSelect` 同款下拉原语 + `ConfirmDeleteButton` 删通道 + `ErrorBanner` 错误横幅 +
`EmptyState` 无通道态。

### 8.0 配置项三条裁定（用户口径 2026-11-21）

1. **每个通道一个配置组**：一通道一张 `ResourceCard`——卡片头 = 平台标识 + 通道名 + 健康徽标 +
   启停 Switch；卡内 = 通用组（全下拉/开关）+ 凭证组（按平台形状，见 8.2）。
2. **能下拉不输入**：通用组五个字段全部下拉/开关（平台、工作区、权限模式、模型、准入模式）；
   **唯一允许手填的是各平台控制台签发的凭证本身**（2~3 个字段，无法下拉也无法代取）。
3. **能免手填就不手填**：自动可得的字段不出现输入框——通道 id/绑定键自动生成不暴露；准入缺省
   「仅首次对话用户」零输入零白名单粘贴；每个凭证组配「去平台创建」引导链接（直跳平台控制台
   对应创建页）+「测试连接」；保存成功即自动测连一次，失败 `ErrorBanner` 回显平台错误原文。
   （后续可选：企微 Secret 扫码授权流——CodeBuddy `Scan QR` 同思路，v1 不承诺。）

### 8.1 通用组字段（所有通道卡内一致）

| 字段 | 控件 | 缺省 | 落点 | 说明 |
|---|---|---|---|---|
| 启用 | `Switch` | 关 | `enabled` | 开=引擎 start 该适配器；关=stop（单适配器热生效，不动其它通道） |
| 工作区 | 下拉 | 聊天专属工作区（自动） | `root` | 首选项「聊天专属工作区（自动）」= `root:'auto'`（§4 绑定解析：每聊天铸造专属工作区目录）；其余选项=GET `/workspaces` 注册表（绑定真实项目为高级用法，配合 mode 收窄） |
| 权限模式 | 下拉 | read-only | `mode` | 三档同 schedules；选 full-access 红字警示（IM 远程驱动写面风险） |
| 模型 | 下拉 | 跟随全局默认 | `model` | 缺省项「跟随全局默认」+ daemon 模型清单（GET `/model` choices）；undefined=不传 per-session model |
| 准入 | 下拉 | 仅首次对话用户 | `allow` | 三档：**仅首次对话用户**（首条私聊消息自动锁定该 userId，零手填）/ 自定义白名单（展开粘贴 userId 列表）/ 不限（红字警告） |

### 8.2 凭证组（每平台形状，字段压到控制台必发的最少集）

| 通道 | 手填字段 | 「去平台创建」引导落点 | 附加提示 |
|---|---|---|---|
| 飞书 | App ID、App Secret | 开放平台「企业自建应用→创建应用→凭证与基础信息」 | 「事件与回调请选**长连接模式**，无需配置回调 URL」 |
| 钉钉 | Client ID (AppKey)、Client Secret | 开发者后台「应用开发→企业内部应用→机器人」 | 「订阅方式请选 **Stream 模式**」 |
| 企业微信 | Bot ID、Secret | 企微客户端「工作台→智能机器人→手动创建→**API 模式**→使用长连接」 | 「Secret 仅显示一次，请立即粘贴保存」 |
| Telegram | Bot Token | @BotFather `/newbot` | 单字段，最简通道 |
| 微信公众号（P3，webhook 形态） | 无（回调 URL 由 daemon 生成展示） | 公众平台「设置与开发→基本配置」 | 回调 URL/Token 只读展示 + 复制钮，**不是输入框** |

凭证输入 `type=password`，卡片展示脱敏（`••••` + 尾 4 位）；**写入目标 = settings env 块的
`SUNSHINEX_CHANNEL_SECRET_<大写通道名>` 槽**（D6「设置与凭据分离」，ProvidersPane 密钥行同机制）；
变更即触发该适配器重启重连。App ID/Bot ID 等非密钥标识进 `channels` 键本键。

### 8.3 连接状态与测试

- 卡片头健康徽标：`adapter.health()` → GET `/channels` 透出（connected/detail），三态
  已连接/未连接/错误（detail 悬浮展示断连原因）。
- 「测试连接」按钮：POST `/channels/:id/test` —— dry-run 连一次立即断开，成功回显机器人身份
  （飞书 bot 名 / 钉钉机器人名 / 企微 bot 名 / Telegram bot username），失败回显平台错误原文。
- 保存成功即自动触发一次 test；启用中的通道断连，引擎按适配器内重连策略自愈（指数退避），
  徽标同步转错误态。

### 8.4 GUI 侧配套面

- **导航注册**：`settings-groups.ts` 基础组插 `{ id: 'channels', title: { en: 'Channels', zh: '通道' } }`
  （「模型与提供方」之后）。
- **壳分发**：`SettingsShell.tsx` renderPane 加 `case 'channels'`（全局形态，不下发 root/scope）。
- **连接面**：`ChannelsPaneConn`（channels 族端点封装）并入 `SettingsShellConn`（:86 并集先例），
  `gui/src/connection.ts` + `connection-api.ts` 加对应方法。
- **全局搜索**：`settings-search.ts` 注册通道条目（pane='channels' + 行锚
  `data-setting-key="channels.feishu.app-id"` 等）——2026-11-21 搜索直达面覆盖。
- **config-changed**：复用既有 `settings` resource tick（`channels` 是 settings 语义键，外部直改
  settings.json 时面板经现有 use-config-changed 自动重拉，无需新 resource）。

## 9. GUI 侧栏「通道」分组与聊天信息条

通道会话独立容器（§4）后，GUI 侧栏需要专属入口。全部照 sunx 的 GUI 先例平移
（`project-menu-sunx.tsx`/`use-menu-sunx.ts`/`conn.sunxSessions()`）。

### 9.1 侧栏「通道」分组

- **数据源**：`GET /channels/sessions` → `SessionRow[]`——扫 `channelsContainerDir()` 各域
  `<domainSlug>/data` 逐域 listSessions 归并（`GET /sunx/sessions` 同构）；行带 root（域目录）。
- **侧栏组**：ProjectMenu 新「通道」组（`ChannelsSection` + `use-menu-channels`，SunxSection 先例）；
  行展示 = 平台图标（飞书/钉钉/企微/Telegram）+ 聊天标识（domainSlug 反解/通道名）+ 会话标题。
- **点击**：`attach(root, journalId)` 直寻址重开（rows 带 root；sunxAttach 同语义）。

### 9.2 用户能否在 GUI 内正常发消息——能（说明）

通道会话就是普通 `SessionRuntime`：侧栏「通道」组点开 = attach 进正常 Chat 视图，输入框
submit（空闲）/steer（运行中）与 IM 消息进**同一条上下文链**——GUI 和 IM 是同一会话的两个入口。
差异只有两处：① GUI 提交不带 `[来自 xx]` 前缀（非 IM 消息）；② IM 侧准入与指令（/new /stop）只在
IM 侧生效。审批卡、计划模式、worktree 等 Chat 全部能力照常可用。

### 9.3 聊天信息条（会话信息 + 可编辑配置）

激活会话属通道域（journalId 命中 `bindings.journalId`）时，Chat 页渲染通道信息条（数据源
`GET /channels/bindings` join 通道配置）：

- **只读信息**：平台（图标+名）、通道实例名（channel id）、聊天 id + 单聊/群聊、
  锁定用户（first-user 模式）、绑定时间、**工作区归属**（「沙箱域」/「真实项目: <path>」；
  rootOverride 在场但未生效时并列「下次 /new 将切至 <目标>」待生效态——三态显示，
  2026-11-21 用户裁定：会话信息须区分实际工作区是沙箱还是真实工作区）。
- **可编辑配置（聊天界面特殊项）**：
  1. **绑定工作区切换**（下拉：聊天专属域（当前）/ 注册项目）→ 写 `bindings.rootOverride`
     （§4 schema 增列），**下次 /new 或解绑重聊生效**，当前会话不动；
  2. **解绑**按钮（DELETE `/channels/bindings/:key`）→ 下一条 IM 消息起全新会话（等价 IM 侧 /new）。
- 会话级 mode/model 编辑复用 Chat 顶部既有控件，不另造。

## 10. 平台接入矩阵（适配器实现速查）

| 平台 | SDK/协议 | 回复语义 | 备注 |
|---|---|---|---|
| 飞书 | `@larksuiteoapi/node-sdk` WSClient（事件订阅长连接，无需公网） | `im.message.reply` + 卡片更新可流式 | 个人可建自建应用，接入成本最低 |
| 钉钉 | `dingtalk-stream` npm（Stream 模式） | 回调载荷携带 sessionWebhook POST 回复；卡片回调走 Stream | 机器人回调/事件/卡片同一条长连接 |
| 企业微信 | 智能机器人 API 模式，自研 ws 客户端连 `wss://openws.work.weixin.qq.com`（`aibot_subscribe` 鉴权帧 + 30s 心跳 + 指数退避） | `aibot_respond_msg` 流式（`stream.id` 帧全量替换）；`aibot_send_msg` 主动推送（24h 有效） | 无官方 Node SDK，协议自实现；CodeBuddy 实现可对标 |
| Telegram | Bot API `getUpdates` 长轮询 | `sendMessage` | 实现量最小，SPI 中立性样板 |
| 微信公众号 | HTTP 回调（需公网 + 验签） | 客服消息接口（48h 窗口） | P3；webhook 形态唯一落点 |
| 微信个人号 | —— | —— | **不接入**：无官方 API，非官方协议封号风险 |
| Slack/Discord | Socket Mode / Gateway（均出站 WS） | 平台 SDK | SPI 即插，无排期 |

## 11. 分期

- **P0 骨架**：`src/serve/channels/` 五件套 + SPI + router/reply 全管线 + mock 适配器 e2e
  （消息→会话→回推全链路断言；daemon.test 的 schedules 用例同口径）。此时已可用 `/channels`
  管理面 + mock 通道联调。
- **P1 首批生产通道**：飞书 + Telegram（一个国内主力 + 一个最简验证）。交付：凭证配置、准入、
  ack、终稿回推、`/new`/`/stop`/`/help`、审批文本回退。
- **P2**：钉钉（Stream）+ 企微（自研 ws 协议，流式 + 卡片）+ `send_channel_message` 工具 +
  GUI 设置页通道 pane（§8：每通道一配置组、通用组全下拉、凭证免手填三原则）+ 侧栏「通道」分组与
  聊天信息条（§9）+ 侧栏通道图标。
- **P3**：公众号 webhook 形态（daemon route auth:false + 验签）+ 流式投影打磨（飞书卡片更新）。

## 12. 测试策略

- **mock 适配器**为唯一权威夹具：`start` 后由测试注入 `InboundMessage`，断言 binding 创建/submit/
  steer 分派、去重、准入拒绝、指令短路；回推断言走 daemon 帧订阅 seam（不必真 IM）。
- daemon 集成：`GuiDaemon` + ChannelsEngine 装配（opts 注入临时 bindings 档——schedulesFile 注入
  先例 daemon.ts:224；`channels` 键走测试档 settings.json），裸跑测试警示同 schedules
  （`--require scripts/test-env.cjs`）。
- 适配器单测只测「平台载荷 ↔ 规范化消息」的纯转换函数（协议编解码拆纯函数，外连逻辑薄壳）。
