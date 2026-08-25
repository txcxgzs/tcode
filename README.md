# TCode

TCode 是一个 Windows 优先的 coding agent harness(编码代理框架):Fastify HTTP 服务 + SQLite trace 存储 + React 前端。模型看到两个工具——一个持久的 `pwsh`(PowerShell)shell 和一个结构化的 `str_replace_editor` 编辑器——通过 Server-Sent Events 流式返回响应。Web UI、权限控制、trace 记录、setup 和 grader 都不进入模型可见的提示词和工具列表。

> **致谢**:本项目的核心设计参考了 [DeepSeek Harness (DSH) Minimal](https://github.com/deepseek-ai) 的模型契约——包括最小化的双工具面、权限模式分层、Windows ACL 沙箱后端,以及 `str_replace_editor` 的路径校验逻辑。沙箱部分直接复用了官方的 `@deepseek-ai/dsh-sandbox-windows-acl` 包。系统提示默认沿用 DSH Minimal 的兜底文案。在此向 DSH 团队表示感谢。

---

## 目录

- [环境要求](#环境要求)
- [安装与启动](#安装与启动)
- [开发模式](#开发模式)
- [REST API](#rest-api)
- [最小契约](#最小契约)
- [权限模式](#权限模式)
- [项目结构](#项目结构)
- [验证](#验证)
- [English](#english)

## 环境要求

- Node.js 22+
- Git for Windows(Git Bash)
- Windows PowerShell 5.1+
- 可选:`@deepseek-ai/dsh-sandbox-windows-acl` 用于受限沙箱模式

## 安装与启动

```powershell
npm install
npm run build
npm start
```

打开 `http://127.0.0.1:3080`。添加一个 OpenAI 兼容的 provider 和若干 model ID。Web API key 保存在本地加密的凭据库中,服务重启后仍然有效,且只以已配置/未配置的元数据形式返回给浏览器,错误信息和 trace 中都会脱敏。

## 开发模式

```powershell
npm run dev
```

前端运行在 `http://127.0.0.1:5173`,API 请求代理到 3080 端口。

## REST API

服务默认绑 `127.0.0.1:3080`。外部 agent 访问方式见根目录的 [`AGENTS.md`](./AGENTS.md),其中包含完整的接口说明和端到端测试示例。

核心接口:

| 接口 | 作用 |
|---|---|
| `POST /api/runs` | 发起运行(body 带 `task.prompt`、`task.workspace`、`task.modelProfile`、`credentialId`) |
| `GET /api/runs/:id` | 查运行状态 |
| `GET /api/runs/:id/events` | SSE 实时事件流 |
| `GET /api/runs/:id/events.json` | 一次性拿全部事件 |
| `POST /api/runs/:id/messages` | 追加消息到正在跑的 run |
| `POST /api/runs/:id/cancel` | 取消运行 |
| `GET /api/sessions` / `POST /api/sessions` | 列出 / 创建会话 |

## 最小契约

默认系统提示是 DSH Minimal 兜底文案的原样照搬:`You are a helpful software engineer assistant.` 只能通过服务端 `DSH_SYSTEM_PROMPT` 环境变量显式替换。Chat Completions 和 Responses 两类 provider 收到相同的两个结构化函数 schema:`pwsh({command})` 和 `str_replace_editor({command,path,...})`。自动上下文压缩已禁用。每次请求、响应、工具动作、审批、grader 结果和用量记录都追加到 `.tcode/runs/<id>.jsonl` 并索引到 `.tcode/runs.sqlite`。

## 权限模式

- `read-only`:DSH 兼容的零写 Windows 沙箱。
- `workspace-write`:DSH 的 Windows ACL 受限令牌沙箱,通过独立的可撤销 SID 放通 workspace 和一个私有临时目录。
- `danger-full-access`:不做进程隔离;编辑器可使用操作系统允许的任意绝对路径。

沙箱模式控制文件系统副作用;审批策略是独立的决策维度。模型面向的进程是一个真实的持久 PowerShell 会话,受限模式用官方 `@deepseek-ai/dsh-sandbox-windows-acl` 后端包裹,若无法建立隔离则 `SANDBOX_UNAVAILABLE` fail-closed。编辑器单独校验绝对路径、workspace 包含关系和 reparse point 祖先链。

DSH 的文件系统沙箱不声称隔离网络。因此 `network: false` 的任务会拒绝 `pwsh` 工具,而不是把代理环境变量当作隔离手段。模型 API 调用始终可用,以便 agent 能返回明确的失败。

## 项目结构

```
src/
  server.ts          Fastify 路由 + SSE,HTTP 层
  runner.ts          run 生命周期、事件追踪、模型循环、审批
  model.ts           provider 调用(chat-completions / responses),流式 + 乱码修复
  shell.ts           node-pty 持久 PowerShell,沙箱包裹
  editor.ts          str_replace_editor 实现
  system-prompt.ts   系统提示 + 工具定义
  permissions.ts     权限模式校验
  trace.ts           SQLite + JSONL trace 存储
  types.ts           zod schema(TaskDefinition 等)
  credentials.ts     加密凭据存储
  cli.ts             命令行入口
  web/               React 前端
test/               vitest 测试
examples/            task.yaml / manifest.yaml 示例
```

## 验证

```powershell
npm run typecheck    # server + web 类型检查
npm test             # vitest 全套测试
npm run build        # 构建产物到 dist/ 和 dist-web/
```

测试覆盖:双工具请求面、持久 shell 的 cwd/env/退出码、编辑器 create/view/unique replace/insert/read-only 行为、真实 Windows ACL 边界强制、权限迁移、凭据与 provider 错误脱敏、Chat Completions 和 Responses 流式、模型发现、mock 的 agent loop、grader、JSONL 持久化。Live provider 验证需要运行时凭据,有意与本地测试分开。

---

## English

TCode is a Windows-first coding agent harness: a Fastify HTTP server, a SQLite trace store, and a React frontend. The model sees exactly two tools — one persistent `pwsh` (PowerShell) shell and one structured `str_replace_editor` — and responses stream back via Server-Sent Events. The Web UI, permissions, tracing, setup, and grading stay outside the model-visible prompt and tool list.

> **Acknowledgement**: The core design of this project is based on the [DeepSeek Harness (DSH) Minimal](https://github.com/deepseek-ai) model contract — including the minimal two-tool surface, layered permission modes, the Windows ACL sandbox backend, and the `str_replace_editor` path-validation logic. The sandbox layer reuses the official `@deepseek-ai/dsh-sandbox-windows-acl` package directly. The default system prompt follows the DSH Minimal fallback verbatim. Credit to the DSH team.

### Requirements

- Node.js 22+
- Git for Windows (Git Bash)
- Windows PowerShell 5.1+
- Optional: `@deepseek-ai/dsh-sandbox-windows-acl` for confined sandbox modes

### Start

```powershell
npm install
npm run build
npm start
```

Open `http://127.0.0.1:3080`. Add a custom OpenAI-compatible provider and one or more model IDs. Web API keys persist locally in an encrypted credential vault, survive server restarts, are returned to the browser only as configured/unconfigured metadata, and are redacted from errors and traces.

### Development

```powershell
npm run dev
```

The Web UI runs at `http://127.0.0.1:5173` and proxies API requests to port 3080.

### REST API

The server binds to `127.0.0.1:3080` by default. See [`AGENTS.md`](./AGENTS.md) in the repo root for the full API surface and an end-to-end test example for external agents.

| Endpoint | Purpose |
|---|---|
| `POST /api/runs` | Start a run (body carries `task.prompt`, `task.workspace`, `task.modelProfile`, `credentialId`) |
| `GET /api/runs/:id` | Run status |
| `GET /api/runs/:id/events` | Live SSE event stream |
| `GET /api/runs/:id/events.json` | All events at once |
| `POST /api/runs/:id/messages` | Append a message to a running run |
| `POST /api/runs/:id/cancel` | Cancel a run |
| `GET /api/sessions` / `POST /api/sessions` | List / create sessions |

### Minimal contract

The default system prompt is the DSH Minimal fallback verbatim: `You are a helpful software engineer assistant.` It can only be replaced explicitly through the server-side `DSH_SYSTEM_PROMPT` environment variable. Chat Completions and Responses providers receive the same two structured function schemas: `pwsh({command})` and `str_replace_editor({command,path,...})`. Automatic context compaction is disabled. Every request, response, tool action, approval, grader result, and usage record is appended to `.tcode/runs/<id>.jsonl` and indexed in `.tcode/runs.sqlite`.

### Permissions

- `read-only`: DSH-compatible zero-write Windows sandbox.
- `workspace-write`: DSH's Windows ACL restricted-token sandbox permits the workspace and a private temporary directory through separate revocable SIDs.
- `danger-full-access`: no process confinement; the editor may use any absolute path allowed by the operating system.

Sandbox mode controls filesystem effects; approval policy is a separate decision. The model-facing process is a real persistent PowerShell session. Restricted modes wrap it with the official `@deepseek-ai/dsh-sandbox-windows-acl` backend and fail closed with `SANDBOX_UNAVAILABLE` if confinement cannot be established. The editor separately validates absolute paths, workspace containment, and reparse-point ancestry.

DSH's filesystem sandbox does not claim to enforce networking. Therefore a task with `network: false` denies `pwsh` instead of presenting proxy environment variables as isolation. Model API calls remain available so the agent can return an explicit failure.

### Verification

```powershell
npm run typecheck
npm test
npm run build
```

Tests cover the exact two-tool request surface, persistent shell cwd/environment/exit codes, editor create/view/unique replace/insert/read-only behavior, real Windows ACL boundary enforcement, permission migration, credential and provider-error redaction, Chat Completions and Responses streaming, model discovery, a mocked agent loop, grading, and JSONL persistence. Live provider verification requires a runtime credential and is intentionally separate from local tests.
