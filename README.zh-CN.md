# Forge

> [English](README.md) | 简体中文

一个开源的、桌面优先的**工程 agent**。给它一个目标，Forge 会规划工作、通过 agent
运行时执行、用真实命令验证结果，并精确展示改了什么——全程由你把控。

Forge 不是聊天机器人，也不是编码助手的封装。它是构建在可替换 Agent Runtime
之上的工程编排系统。

> **状态：Alpha，积极开发中。** 核心生命周期、验证、恢复和记忆层已可用；真实任务的
> 成功率仍高度依赖你所搭配的模型与运行时。见[已知问题](#已知问题)。

---

## 架构

Forge 把「决定做什么」和「执行动作」分开：

```
Forge（决策）                        Runtime（执行）
─────────────────                    ──────────────────
任务生命周期                          LLM 回合
规划                                  工具调用
执行管理                              文件编辑
验证                                  命令
恢复                                  ...
记忆
        │                                   │
        └────────► AgentRuntime（接口）─────┘
                          │
                    Pi 运行时适配器
                          │
                        Pi
```

因为 `AgentRuntime` 接口之上的所有东西都与运行时无关，底层的运行时始终可替换。
当前 Forge 内置了 **Pi** 适配器。

端到端：

```
桌面端（React / Tauri v2）
        │  HTTP + SSE
   forge serve（Node sidecar）
        │
   TaskManager ──► Orchestrator（状态机）
        │              UNDERSTAND → PLAN → EXECUTE → OBSERVE → FIX → COMPLETE
        │
   AgentRuntime ──► Pi 子进程（NDJSON RPC）──► 模型 provider
```

## 任务生命周期

```
READY → UNDERSTAND → PLAN → EXECUTE → OBSERVE ──┬──► EVALUATE → COMPLETE
                          ▲                     │
                          └──────── FIX ────────┘
```

没有任何一步仅凭模型的「一面之词」就完成：只有当一个步骤的成功标准通过
（`file_exists`、`file_contains`、`command_exit_zero`、`test_pass` 等），它才算完成。
失败会走一个带预算上限的 FIX 恢复流程，然后如实暴露。

## 对话 vs 工程任务

并非每个输入都是任务。Forge 会对会话的第一条消息做分流：

```
用户输入 → 意图路由（服务端 mini completion）
                 ├─ conversation → 一次模型调用，直接回复，轻量会话记录
                 └─ task         → 完整生命周期：规划 → 执行 → 验证 → 完成
```

聊天就是聊天（不伪造计划、不伪造验证步骤）；真正的工程请求走完整流水线。

## 安全

- **Guard**：对每次工具调用做基于能力的策略控制——`read/write/edit` 允许；
  `bash`、网络和 git 写入会询问；破坏性动作被拒绝并终止任务。「始终允许」会把规则
  写入 `~/.forge/guard.json`。
- **就地执行**：任务在你选中的项目目录里运行，而不是沙箱副本——这正是审批存在的
  原因。
- **Diff & Undo**：文件写入前会先做日志记录；桌面端展示 diff，并可还原。

## 快速开始

要求：Node 22+、Rust（用于桌面外壳）。**Pi** 运行时已 vendored 在 `pi/` 目录，是
本仓库的一部分——我们直接演进它。

```bash
# 桌面应用
cd desktop
npm install
npm run tauri dev

# 或者只跑服务端
npx tsx src/cli/serve.ts --port 5300 --runtime pi

# 或者从 CLI 跑单个任务
npx tsx src/cli/run.ts run "创建一个带测试的 TypeScript 工具模块"
```

在应用的 Settings 里管理模型订阅（可添加多个厂商/模型、设置默认、按任务或会话切换），
或直接编写 `~/.forge/forge-config.json`。

## 开发

```bash
npm run typecheck              # server + core 类型检查
cd desktop && npm run typecheck
bash scripts/release-check.sh  # 类型检查 + 单元测试 + 集成 + 全新安装（25 项）
```

设计说明在 `docs/`，工程规则在 `AGENTS.md`，产品方向在 `ROADMAP.md`。

## 已知问题

- 流式 CJK 串位（已缓解）：部分 provider 的流式 `text_delta` 事件会以乱序到达，但
  运行时的最终 `message_end` 消息是干净的。Forge 现在会在每个消费点（turn 结果、
  会话历史、桌面视图）用权威终态文本替换累积的 delta，因此消息完成时乱序会自动校正。
  根因在 Pi 的流式适配器；既然 Pi 已 vendored，我们会在源头修复——见
  `docs/19-PI-UPSTREAM-ISSUES.md`。
- 真实任务的成功率因模型而异很大；弱的 agentic 模型会产出它们无法完成的计划。
  验证会抓住问题，但任务会失败。

## 目录结构

```
src/           Forge 核心：orchestrator、planner、runtime 接口、server、guard、memory
desktop/       Tauri v2 + React 桌面应用
scripts/       发布验证
docs/          设计与架构说明
benchmark/     黄金任务基准
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
