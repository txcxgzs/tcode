# TCode Minimal Harness

Windows-first host for the DeepSeek Harness Minimal model contract. The model sees exactly one persistent `bash` tool and one structured `str_replace_editor` tool. The Web UI, permissions, tracing, setup, and grading stay outside the model-visible prompt and tool list.

## Start

Requires Node.js 22+, Git for Windows (Git Bash), and Windows PowerShell 5.1.

```powershell
npm install
npm run build
npm start
```

Open `http://127.0.0.1:3080`. Add a custom OpenAI-compatible provider and one or more model IDs. Web API keys persist locally in an encrypted credential vault, survive server restarts, are returned to the browser only as configured/unconfigured metadata, and are redacted from errors and traces.

For development:

```powershell
npm run dev
```

The Web UI runs at `http://127.0.0.1:5173` and proxies API requests to port 3080.

## CLI

The CLI reads credentials only from the process environment:

```powershell
$env:TCODE_API_KEY = '<your provider key>'
npx tcode run examples/task.yaml
npx tcode batch examples/manifest.yaml
npx tcode replay <run-id>
```

`serve`, `run`, `batch`, and `replay` are available. Interactive `run` prompts for approvals. Unattended `batch` denies pending approvals, so batch manifests should normally use `workspace-write` with disposable fixtures.

## Minimal contract

The default system prompt is the DSH Minimal fallback verbatim: `You are a helpful software engineer assistant.` It can only be replaced explicitly through the server-side `DSH_SYSTEM_PROMPT` environment variable. Chat Completions and Responses providers receive the same two structured function schemas: `bash({command})` and `str_replace_editor({command,path,...})`. Automatic context compaction is disabled. Every request, response, tool action, approval, grader result, and usage record is appended to `.tcode/runs/<id>.jsonl` and indexed in `.tcode/runs.sqlite`.

Permissions:

- `read-only`: DSH-compatible zero-write Windows sandbox.
- `workspace-write`: DSH's Windows ACL restricted-token sandbox permits the workspace and a private temporary directory through separate revocable SIDs.
- `danger-full-access`: no process confinement; the editor may use any absolute path allowed by the operating system.

Sandbox mode controls filesystem effects; approval policy is a separate decision. The model-facing process is a real persistent Git Bash session. Restricted modes wrap it with the official `@deepseek-ai/dsh-sandbox-windows-acl` backend and fail closed with `SANDBOX_UNAVAILABLE` if confinement cannot be established. The editor separately validates absolute paths, workspace containment, and reparse-point ancestry. PowerShell remains internal-only for setup and grader commands and is never advertised to the model.

DSH's filesystem sandbox does not claim to enforce networking. Therefore a task with `network: false` denies `bash` instead of presenting proxy environment variables as isolation. Model API calls remain available so the agent can return an explicit failure.

## Verification

```powershell
npm run typecheck
npm test
npm run build
```

Tests cover the exact two-tool request surface, persistent Bash cwd/environment/exit codes, editor create/view/unique replace/insert/read-only behavior, real Windows ACL boundary enforcement, permission migration, credential and provider-error redaction, Chat Completions and Responses streaming, model discovery, a mocked agent loop, grading, and JSONL persistence. Live provider verification requires a runtime credential and is intentionally separate from local tests.
