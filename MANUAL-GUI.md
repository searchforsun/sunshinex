# GUI 手册（预览）

> 浏览器界面建设中，当前面向开发调试。

## 启动 / 停止

| 命令 | 说明 |
| --- | --- |
| `sunshinex serve [目录] [--port=N]` | 启动 daemon；终端打印地址与鉴权 token |

停止：`Ctrl+C`。

## HTTP 接口

| 端点 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /healthz` | 无 | 探活 |
| `GET /snapshot` | Bearer | 全量状态快照 |
| 其余路径 | — | 静态资源（对话页建设中） |

鉴权头：`Authorization: Bearer <token>`。

## WebSocket 事件流

| 项 | 说明 |
| --- | --- |
| 接入 | 同端口 HTTP upgrade |
| 鉴权 | `Authorization: Bearer <token>` 头，或 subprotocol `bearer.<token>`（浏览器路径） |
| 补发 | 连接即补发缓冲帧（近 512 帧），此后实时推送 |
| 帧形态 | `{kind:'event',…}` 等，协议见 `docs/superpowers/specs/`（G1/G3 系列） |

## 状态

| 项 | 状态 |
| --- | --- |
| daemon（G1） | 已交付 |
| gui 包 / 连接层（G2） | 已交付 |
| 对话页（G3） | 建设中 |
| TUI ↔ GUI | 同一数据底座，跨时间切换（非同时双开） |
