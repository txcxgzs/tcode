# TCode — Agent 快速上手

TCode 是一个 Windows 优先的 coding agent harness:Fastify HTTP 服务(默认 3080 端口)+ SQLite trace 存储 + React 前端。模型看到两个工具(`pwsh` 持久 shell、`str_replace_editor` 结构化编辑器),通过 Server-Sent Events 流式返回。

## 环境要求

- Node.js 22+
- Git for Windows(Git Bash)
- Windows PowerShell 5.1+(`pwsh` 工具的后端)
- 可选:`@deepseek-ai/dsh-sandbox-windows-acl` 用于受限沙箱模式

## 安装与启动

```bash
npm install        # 安装依赖,node-pty 会本地编译(需 MSVC 工具链)
npm run build      # 编译 server (tsc) + 前端 (vite build)
npm start          # 启动服务,默认 http://127.0.0.1:3080
```

开发模式(热更新):
```bash
npm run dev        # server :3080 + vite :5173(代理 API 到 3080)
```

## 让外部 agent 访问

服务默认绑 `127.0.0.1`。要让云端 agent 通过公网访问,二选一:

1. **隧道(推荐,免改代码)**:
   ```bash
   cloudflared tunnel --url http://127.0.0.1:3080
   # 得到一个 https://*.trycloudflare.com 公网地址
   ```

2. **绑 0.0.0.0 + 放通端口**:
   ```bash
   npx tcode serve --host 0.0.0.0 --port 3080
   ```
   然后在防火墙放通 3080。注意:`POST /api/runs` 需要已配置的 provider 凭据,不暴露 API key。

## REST API

所有接口返回 JSON,`POST` 请求体 `application/json`。不带 `Origin` 头的客户端(编程式 HTTP 客户端)不受 CORS 限制。

### 健康检查
```
GET /api/health
→ { "ok": true, "version": "0.1.0", "platform": "win32" }
```

### 列出已配置的 provider
```
GET /api/model-profiles
→ [{ "id": "txai", "name": "...", "baseUrl": "...", "protocol": "chat-completions",
     "models": [{ "id": "stealth/ox-alpha" }, ...], ... }]
```
`id` 字段在创建 run 时作为 `credentialId` 传入。

### 列出 workspace
```
GET /api/workspaces
→ [{ "path": "C:\\Users\\...\\tcode", ... }]
```
`path` 作为创建 run 时的 `task.workspace`。

### 创建 / 列出会话
```
POST /api/sessions
body: { "workspacePath": "<workspace path>", "permissionMode": "workspace-write" }
→ 201 { "id": "...", ... }

GET /api/sessions
→ [{ "id": "...", "title": "...", "workspacePath": "...", "permissionMode": "...", ... }]
```

### 发起一次运行(核心入口)
```
POST /api/runs
body: {
  "task": {
    "prompt": "你的指令",
    "workspace": "C:\\Users\\Administrator\\Desktop\\tcode",
    "modelProfile": {
      "baseUrl": "https://ai.txcxgzs.com/v1",
      "protocol": "chat-completions",
      "model": "stealth/ox-alpha"
    },
    "permissionMode": "workspace-write",   // read-only | workspace-write | danger-full-access
    "sessionId": "<可选,追加到已有会话>",
    "timeout": 1800000,
    "toolTimeout": 300000,
    "maxTurns": 100,
    "network": true,
    "setup": [],
    "grader": []
  },
  "credentialId": "txai",     // 必须与 task.modelProfile 同源
  "adhd": false               // 可选,附加 ADHD skill 提示
}
→ 202 { "id": "<run-id>", "status": "queued", ... }
```

`credentialId`、`baseUrl`、`protocol`、`model` 四者必须属于同一个已配置的 provider,否则返回 400。

### 查运行状态
```
GET /api/runs/:id
→ { "id": "...", "status": "running", "task": {...}, "createdAt": "...", ... }

GET /api/runs           # 列全部 run
```

### 实时事件流(SSE)
```
GET /api/runs/:id/events
# text/event-stream,每条: data: {"type":"...","data":{...},...}\n\n
```
事件类型(按发生顺序):
- `run_started` — run 开始
- `user_message` — 用户输入(含初始 prompt,mode="initial")
- `model_request` — 向 provider 发请求
- `model_first_token` — 首 token
- `model_delta` — 增量文本(流式)
- `model_response` — 一轮完整模型回复
- `tool_call` — 模型调用工具
- `tool_result` — 工具执行结果
- `run_failed` — 失败
- `run_finished` — 完成

### 一次性拿全部事件
```
GET /api/runs/:id/events.json
→ [ { "type": "...", "data": {...}, "seq": N, "runId": "..." }, ... ]
```

### 追加消息到正在跑的 run
```
POST /api/runs/:id/messages
body: { "content": "补充指令", "mode": "queue" }   // queue | steer
→ 202 { "ok": true }
```
`queue`:排队等当前轮结束后处理;`steer`:打断当前轮转向。run 不在运行中则 409。

### 取消运行
```
POST /api/runs/:id/cancel
→ 200 { "ok": true } | 409 { "error": "Run is not active" }
```

### 反馈
```
POST /api/runs/:id/feedback
body: { "rating": "up" | "down", "comment": "..." }
```

## 一个完整的测试流程(给 agent 的示例)

```bash
# 1. 确认服务活着
curl http://127.0.0.1:3080/api/health

# 2. 拿 provider id 和 workspace path
curl http://127.0.0.1:3080/api/model-profiles
curl http://127.0.0.1:3080/api/workspaces

# 3. 起 run(把 <WORKSPACE> 和 provider 信息换成实际的)
RUN_ID=$(curl -s -X POST http://127.0.0.1:3080/api/runs \
  -H "content-type: application/json" \
  -d '{
    "task": {
      "prompt": "列出当前 workspace 下的所有 .ts 文件,并统计每个文件的行数",
      "workspace": "<WORKSPACE>",
      "modelProfile": {
        "baseUrl": "https://ai.txcxgzs.com/v1",
        "protocol": "chat-completions",
        "model": "stealth/ox-alpha"
      },
      "permissionMode": "read-only",
      "maxTurns": 20
    },
    "credentialId": "txai"
  }' | python -c "import sys,json; print(json.load(sys.stdin)['id'])")

echo "Run: $RUN_ID"

# 4. 轮询状态直到完成
while true; do
  STATUS=$(curl -s http://127.0.0.1:3080/api/runs/$RUN_ID | python -c "import sys,json; print(json.load(sys.stdin)['status'])")
  echo "status: $STATUS"
  [ "$STATUS" = "finished" ] || [ "$STATUS" = "failed" ] && break
  sleep 2
done

# 5. 看全部事件(模型回复、工具调用、结果都在这里)
curl -s http://127.0.0.1:3080/api/runs/$RUN_ID/events.json | python -m json.tool
```

## 项目结构

```
src/
  server.ts          Fastify 路由 + SSE,HTTP 层
  runner.ts          run 生命周期、事件追踪、模型循环、审批
  model.ts           provider 调用(chat-completions / responses),流式 + 乱码修复
  shell.ts           node-pty 持久 PowerShell,沙箱包裹
  editor.ts          str_replace_editor 实现
  system-prompt.ts   系统提示 + 工具定义(pwsh / str_replace_editor)
  permissions.ts     权限模式校验
  trace.ts           SQLite + JSONL trace 存储
  types.ts           zod schema(TaskDefinition 等)
  credentials.ts     加密凭据存储
  adhd-skill.ts      ADHD skill 文本
  cli.ts             命令行入口
  web/               React 前端
    src.tsx
    style.css / settings.css
test/               vitest 测试
examples/            task.yaml / manifest.yaml 示例
```

## 验证

```bash
npm run typecheck    # server + web 类型检查
npm test             # vitest 全套测试
npm run build        # 构建产物到 dist/ 和 dist-web/
```

## 注意事项

- `POST /api/runs` 不接受内联 API key,凭据必须先在 Web UI 或通过凭据 API 配好,然后用对应的 `credentialId` 引用。
- read-only 模式:shell 写操作被沙箱拒绝;workspace-write:写需审批(`approvalPolicy:"ask"`);danger-full-access:无限制。
- SSE 流有 15s keepalive;客户端断开会取消订阅。
- trace 全量记录到 `.tcode/runs.sqlite` 和 `.tcode/runs/<id>.jsonl`。
