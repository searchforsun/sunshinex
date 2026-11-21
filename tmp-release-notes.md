## Sunshinex v0.7.0 — 定时任务

主打新能力：**定时任务（调度器）** —— daemon 级全局调度，按本地时间到点**新建会话并自动发送任务**：

- 周期任选：每小时 / 每天 / 每周 / 每月（及分钟与自定义间隔），支持**截止时间**、停/启开关、立即执行
- 逐次**执行记录**（定时 / 补跑 / 手动三种触发 × 成功 / 失败 / 跳过 / 已中断 / 已停止 / 运行中状态，可一键回跳原会话）
- 可靠性：停运或休眠唤醒后到期任务只补跑一次；上次未跑完自动记「跳过」，不并行堆积
- **自然语言创建**：对话里一句「帮我创建一个每天 9:00 的定时任务：检查项目代码变更并给出风险提示」即可（`create_scheduled_task` 工具，工作区/权限/模型与思考强度随会话沿用，任务可固定模型）
- Sunx 会话内另有一次性的唤醒与定时派发（`schedule_wakeup` / `schedule_task`）

### 其他更新（v0.6.0 以来节选）

- **GUI 工作台**：D62 专项收官——App 壳组件化（App.tsx 1503→780 行，panes / 覆盖层 / tabs / 菜单四大钩子域收口）；搜索浮层视口钳制；分派行蓝链与成员面板；定时任务截止时间弹层两栏化
- **引擎**：dispatch_task 收敛为一次性子智能体分派；待答提问随任务停止留痕；会话旁钟面图标标识定时执行会话
- **质量**：测试门禁分批复活（测试启动器 argv 分批修复超长命令行静默失效）；五轮连清 + 冗余 export 三批清偿（约 222 处）；G/M 类全量普查登记 D84–D106 持续清偿

### 安装

- TUI：`npm install -g https://github.com/searchforsun/sunshinex/releases/download/v0.7.0/sunshinex-agent-0.7.0.tgz`
- GUI 桌面端：下载下方安装包（Windows x64 为 `sunshinex-0.7.0-win-x64-setup.exe`，双击安装）

**Full Changelog**: https://github.com/searchforsun/sunshinex/compare/v0.6.0...v0.7.0
