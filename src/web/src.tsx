import DOMPurify from "dompurify";
import { marked } from "marked";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./settings.css";
type L = "zh" | "en";
type E = { seq: number; runId?: string; at: string; type: string; data: Record<string, any> };
type R = {
  id: string;
  status: string;
  createdAt: string;
  task: any;
  error?: string;
};
type A = { id: string; input: string; reasons: string[]; danger?: boolean; approvalKey?: string };
type W = { id: string; path: string; title: string };
type PM = { id: string; name?: string; contextBudget?: number; maxOutputTokens?: number };
type MP = { id: string; name: string; baseUrl: string; protocol: "chat-completions" | "responses"; models: PM[] };
type S = {
  id: string;
  workspacePath: string;
  title: string;
  blank: boolean;
  permissionMode: string;
  createdAt: string;
  updatedAt: string;
};
marked.setOptions({ gfm: true, breaks: true });
function Markdown({ text }: { text: string }) {
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(text, { async: false })) }} />;
}

const C = {
  zh: {
    new: "新会话",
    none: "暂无会话",
    settings: "设置",
    chat: "对话",
    trajectory: "轨迹",
    message: "描述你想要构建的内容",
    mistakes: "TCode 可能会犯错，请检查工具调用和文件更改。",
    working: "正在处理",
    tools: "次工具调用",
    details: "详情",
    inspect: "选择消息或工具调用以查看原始事件。",
    export: "导出运行数据",
    approval: "需要批准",
    deny: "拒绝",
    allow: "允许一次",
    open: "打开设置",
    general: "通用",
    models: "模型",
    language: "界面语言",
    languageHelp: "更改 TCode 的显示语言",
    configured: "已配置",
    unconfigured: "未配置",
    edit: "编辑",
    save: "保存",
    close: "关闭",
    stopped: "运行已停止",
    failed: "运行失败",
    keyFirst: "请先在「设置 → 模型」中配置 API Key。",
    reviewMode: "工作区写入",
    reviewHelp: "写入需审核；工作区外路径一律拒绝",
    askMode: "只读",
    askHelp: "阻止文件修改",
    fullMode: "完全访问",
    fullHelp: "不限范围；越界访问会向模型注入警告",
  },
  en: {
    new: "New session",
    none: "No sessions yet",
    settings: "Settings",
    chat: "Chat",
    trajectory: "Trajectory",
    message: "Describe what you want to build",
    mistakes: "TCode may make mistakes. Review tool calls and file changes.",
    working: "Working on it",
    tools: "tool calls",
    details: "Details",
    inspect: "Select a message or tool call to inspect its raw event.",
    export: "Export run data",
    approval: "Approval required",
    deny: "Deny",
    allow: "Allow once",
    open: "Open settings",
    general: "General",
    models: "Models",
    language: "Interface language",
    languageHelp: "Change the language used by TCode",
    configured: "Configured",
    unconfigured: "Not configured",
    edit: "Edit",
    save: "Save",
    close: "Close",
    stopped: "Run stopped",
    failed: "Run failed",
    keyFirst: "Configure an API key in Settings → Models first.",
    reviewMode: "Workspace write",
    reviewHelp: "Writes are reviewed; out-of-workspace paths are denied",
    askMode: "Read only",
    askHelp: "Block file changes",
    fullMode: "Full access",
    fullHelp: "No restrictions; boundary crossings inject a warning",
  },
};
const D = {
  workspace: "C:\\Users\\Administrator\\Desktop\\tcode",
  baseUrl: localStorage.getItem("tcode.baseUrl") ?? "",
  model: localStorage.getItem("tcode.model") ?? "",
  protocol: (localStorage.getItem("tcode.protocol") as MP["protocol"]) || "chat-completions",
  permissionMode: "workspace-write",
  network: true,
  reasoningEffort: "",
  contextBudget: 120000,
  maxTurns: 100,
};
const paths: Record<string, React.ReactNode> = {
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16M6 8h.01M6 12h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1v.1H9.5V21a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1-.4h-.1V9.5h.1A1.7 1.7 0 0 0 4 8.4a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.46 3.6l.06.06A1.7 1.7 0 0 0 8.4 4a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1v-.1h4.1v.1A1.7 1.7 0 0 0 15 4a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8.4a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1 .4h.1v4.1H21a1.7 1.7 0 0 0-1.6 1.1Z" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  chatBubble: <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z" />,
  archive: <><path d="M4 7h16v13H4V7Z" /><path d="M3 4h18v3H3V4Zm6 8h6" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3m-9 0 1 14h10l1-14M10 11v6m4-6v6" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  down: <path d="m8 10 4 4 4-4" />,
  send: <path d="M12 19V5m-6 6 6-6 6 6" />,
  bolt: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />,
  code: <path d="m8 9-3 3 3 3m8-6 3 3-3 3m-2-8-4 10" />,
  sliders: <path d="M4 7h10m4 0h2M4 17h2m4 0h10M14 5v4M6 15v4" />,
  spark: (
    <path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Z" />
  ),
  edit: <><path d="M4 20h4l11-11-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
  terminal: <path d="m5 7 4 4-4 4m7 2h7" />,
  document: <path d="M6 3h9l3 3v15H6V3Zm9 0v4h4M9 11h6M9 15h6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  fork: <><circle cx="7" cy="5" r="2" /><circle cx="17" cy="19" r="2" /><circle cx="7" cy="19" r="2" /><path d="M7 7v10m0-6h5a5 5 0 0 1 5 5v1" /></>,
  thumbsUp: <path d="M7 10v10H4V10h3Zm0 9h9.2a2 2 0 0 0 1.9-1.4l1.7-5.5A2 2 0 0 0 17.9 9H14l.6-3.1A2.4 2.4 0 0 0 12.2 3L7 10" />,
  thumbsDown: <path d="M7 14V4H4v10h3Zm0-9h9.2a2 2 0 0 1 1.9 1.4l1.7 5.5A2 2 0 0 1 17.9 15H14l.6 3.1a2.4 2.4 0 0 1-2.4 2.9L7 14" />,
  download: <><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M5 20h14" /></>,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  tune: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" fill="white" />
      <circle cx="15" cy="12" r="2" fill="white" />
      <circle cx="8" cy="18" r="2" fill="white" />
    </>
  ),
  folderPlus: (
    <>
      <path d="M3 8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8H3V8Z" />
      <path d="M17 3v6m-3-3h6" />
    </>
  ),
  copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  shield: (
    <path d="M12 3 5 6v5c0 4.7 2.9 8 7 10 4.1-2 7-5.3 7-10V6l-7-3Zm-3 9 2 2 4-4" />
  ),
  readOnly: <><path d="M12 3 5 6v5c0 4.7 2.9 8 7 10 4.1-2 7-5.3 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>,
  workspaceWrite: <><rect x="5" y="3.5" width="12" height="16" rx="2" /><path d="M8.5 8h5M8.5 11.5H12" /><path d="m11 17 5.7-5.7 2 2L13 19h-2v-2Z" /></>,
  fullAccess: <><path d="M12 3 5 6v5c0 4.7 2.9 8 7 10 4.1-2 7-5.3 7-10V6l-7-3Z" /><path d="M12 8v5m0 3h.01" /></>,
};
const I = ({ name }: { name: string }) => (
  <svg
    className={"icon icon-" + name}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {name === "stop" ? (
      <rect
        x="8"
        y="8"
        width="8"
        height="8"
        rx="1"
        fill="currentColor"
        stroke="none"
      />
    ) : (
      paths[name]
    )}
  </svg>
);

function TCodeBrand({ markOnly = false }: { markOnly?: boolean }) {
  return (
    <span className={markOnly ? "tcode-brand mark-only" : "tcode-brand"}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="7" />
        <path d="m7.5 8.25 3.75 3.75-3.75 3.75M13.25 15.75h3.75" fill="none" stroke="white" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {!markOnly && (
        <strong>TCode</strong>
      )}
    </span>
  );
}

function RoseLoader() {
  const groupRef = useRef<SVGGElement | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const particlesRef = useRef<SVGCircleElement[]>([]);
  useEffect(() => {
    let frame = 0;
    const startedAt = performance.now();
    const point = (progress: number, detail: number) => {
      const t = progress * Math.PI * 2;
      const a = 9.2 + detail * 0.6;
      const r = a * (0.72 + detail * 0.28) * Math.cos(2 * t);
      return { x: 50 + Math.cos(t) * r * 3.25, y: 50 + Math.sin(t) * r * 3.25 };
    };
    const render = (now: number) => {
      const time = now - startedAt;
      const progress = (time % 5200) / 5200;
      const detail = 0.52 + ((Math.sin(((time % 4300) / 4300) * Math.PI * 2 + 0.55) + 1) / 2) * 0.48;
      groupRef.current?.setAttribute("transform", `rotate(${-((time % 28000) / 28000) * 360} 50 50)`);
      pathRef.current?.setAttribute("d", Array.from({ length: 481 }, (_, i) => {
        const p = point(i / 480, detail);
        return `${i ? "L" : "M"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
      }).join(" "));
      particlesRef.current.forEach((node, index) => {
        const tail = index / 73;
        const p = point(((progress - tail * 0.3) % 1 + 1) % 1, detail);
        const fade = Math.pow(1 - tail, 0.56);
        node.setAttribute("cx", p.x.toFixed(2));
        node.setAttribute("cy", p.y.toFixed(2));
        node.setAttribute("r", (0.9 + fade * 2.7).toFixed(2));
        node.setAttribute("opacity", (0.04 + fade * 0.96).toFixed(3));
      });
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <span className="rose-loader" role="status" aria-label="正在处理">
      <svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
        <g ref={groupRef}>
          <path ref={pathRef} stroke="currentColor" strokeWidth="4.6" strokeLinecap="round" strokeLinejoin="round" opacity=".1" />
          {Array.from({ length: 74 }, (_, index) => (
            <circle key={index} ref={(node) => { if (node) particlesRef.current[index] = node; }} fill="currentColor" />
          ))}
        </g>
      </svg>
    </span>
  );
}

const formatDuration = (ms: number) =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
const formatTokens = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K` : String(value);

const EVENT_ZH: Record<string, string> = {
  run_started: "运行开始", run_finished: "运行完成", run_failed: "运行失败",
  user_message: "用户消息", user_message_queued: "用户消息已排队",
  model_request: "模型请求", model_first_token: "模型首 token", model_delta: "模型增量", model_response: "模型响应",
  tool_call: "工具调用", tool_result: "工具结果", message_feedback: "消息反馈",
};

const eventDisplayName = (type: string, lang: L) =>
  lang === "zh" ? (EVENT_ZH[type] ?? type.replaceAll("_", " ")) : type.replaceAll("_", " ");

const eventTime = (event?: E) => event ? new Date(event.at).getTime() : 0;
const estimateDisplayTokens = (value: unknown) => Math.max(0, Math.ceil(JSON.stringify(value ?? "").length / 4));
// The download endpoint fences artifacts to the workspace; only generate
// links for paths it will actually serve.
const insideWorkspace = (workspace: string, path: string) => {
  const norm = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const base = norm(workspace);
  const candidate = norm(path);
  return base !== "" && (candidate === base || candidate.startsWith(base + "/"));
};

// SSE appends and the 1.2s snapshot poll run concurrently; merging by seq
// (never wholesale-replacing) keeps freshly streamed events from flickering.
const mergeEvents = (existing: E[], incoming: E[]) => {
  if (!incoming.length) return existing;
  const seen = new Set(existing.map((event) => event.seq));
  const fresh = incoming.filter((event) => !seen.has(event.seq));
  if (!fresh.length) return existing;
  return existing.concat(fresh).sort((a, b) => a.seq - b.seq);
};

function runPerformance(events: E[]) {
  const requests = events.filter((event) => event.type === "model_request");
  let llmMs = 0;
  const firstTokenMs: number[] = [];
  for (const request of requests) {
    const response = events.find((event) => event.seq > request.seq && event.type === "model_response");
    if (!response) continue;
    llmMs += Math.max(0, eventTime(response) - eventTime(request));
    const delta = events.find((event) => event.seq > request.seq && event.seq < response.seq && (event.type === "model_first_token" || event.type === "model_delta"));
    if (delta) firstTokenMs.push(Math.max(0, eventTime(delta) - eventTime(request)));
  }
  const toolCalls = events.filter((event) => event.type === "tool_call");
  let toolMs = 0;
  for (const call of toolCalls) {
    const result = events.find((event) => event.type === "tool_result" && event.data.toolCallId === call.data.id);
    if (result) toolMs += Math.max(0, eventTime(result) - eventTime(call));
  }
  const outputTokens = events
    .filter((event) => event.type === "model_response")
    .reduce((total, event) => total + Number(event.data.usage?.outputTokens ?? 0), 0);
  return {
    llmMs,
    toolMs,
    averageFirstTokenMs: firstTokenMs.length ? Math.round(firstTokenMs.reduce((a, b) => a + b, 0) / firstTokenMs.length) : 0,
    tokensPerSecond: llmMs ? outputTokens / (llmMs / 1000) : 0,
  };
}

function responsePerformance(events: E[], response: E) {
  const request = [...events].reverse().find((event) => event.seq < response.seq && event.type === "model_request");
  if (!request) return null;
  const firstToken = events.find((event) => event.seq > request.seq && event.seq < response.seq && event.type === "model_first_token");
  const durationMs = Math.max(0, eventTime(response) - eventTime(request));
  const firstTokenMs = firstToken ? Math.max(0, eventTime(firstToken) - eventTime(request)) : 0;
  const generationMs = firstToken ? Math.max(1, eventTime(response) - eventTime(firstToken)) : Math.max(1, durationMs);
  const outputTokens = Number(response.data.usage?.outputTokens ?? 0);
  return { request, durationMs, firstTokenMs, outputTokens, tokensPerSecond: outputTokens ? outputTokens / (generationMs / 1000) : 0 };
}

function eventInspection(events: E[], event: E) {
  const component = event.type.startsWith("tool_") ? "tool" : event.type.startsWith("model_") ? "model" : "core";
  let related: E | undefined;
  if (event.type === "model_response" || event.type === "model_first_token" || event.type === "model_delta")
    related = [...events].reverse().find((candidate) => candidate.seq < event.seq && candidate.type === "model_request");
  if (event.type === "tool_result")
    related = events.find((candidate) => candidate.type === "tool_call" && candidate.data.id === event.data.toolCallId);
  const durationMs = related ? Math.max(0, eventTime(event) - eventTime(related)) : undefined;
  return { component, related, durationMs };
}

function CopyAction({ text, label = "复制" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return <button className="copy-action" onClick={async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await navigator.clipboard.writeText(text);
    setDone(true);
    window.setTimeout(() => setDone(false), 1200);
  }} aria-label={done ? "已复制" : (label || "复制")} title={done ? "已复制" : (label || "复制")}><I name={done ? "check" : "copy"} /></button>;
}

function Tool({ e, result, onPick }: { e: E; result?: E; onPick: () => void }) {
  const args = e.data.input && typeof e.data.input === "object" ? e.data.input as Record<string, unknown> : {};
  let tool = e.data.name ?? e.data.tool,
    input = typeof e.data.input === "string" ? e.data.input : JSON.stringify(e.data.input ?? {}, null, 2),
    out = String(result?.data.output ?? "");
  const patchPath = typeof args.path === "string" ? args.path : undefined;
  const isPatch = tool === "str_replace_editor" && String(args.command ?? "") !== "view";
  const editorCommand = String(args.command ?? "");
  const editorText = String(args.file_text ?? args.new_str ?? "");
  const added = editorText.split(/\r?\n/).filter(Boolean);
  const removed = String(args.old_str ?? "").split(/\r?\n/).filter(Boolean);
  return (
    <details className="tool-card rich-tool" open>
      <summary onClick={onPick}>
        <span className={"tool-kind " + (out.startsWith("Error:") ? "bad" : "")}><I name={isPatch ? "edit" : "terminal"} /></span>
        <strong>{tool === "pwsh" ? "PowerShell" : editorCommand === "view" ? "查看" : editorCommand === "create" ? "写入" : "编辑"}</strong>
        <code>{patchPath ?? editorCommand.slice(0, 80)}</code>
        <CopyAction text={input} />
        <I name="chevron" />
      </summary>
      <div className="tool-body">
        {isPatch ? <div className="diff-view">
          {patchPath && <b>{patchPath}</b>}
          <pre>{[
            ...removed.map((line, index) => <span className="remove" key={`d${index}`}>−{line || " "}</span>),
            ...editorText.split(/\r?\n/).map((line, index) => <span className="add" key={`a${index}`}>+{line || " "}</span>),
          ]}</pre>
          <small>+{added.length} −{removed.length} · 1 file</small>
        </div> : <div className="tool-input"><b>$</b><pre>{String(args.command ?? input)}</pre></div>}
        {out && <pre className="tool-output">{out}</pre>}
      </div>
    </details>
  );
}
function App() {
  const [lang, setLang] = useState<L>(
      () => (localStorage.getItem("tcode.locale") as L) || "zh",
    ),
    t = C[lang];
  const [s, setS] = useState(D),
    [prompt, setPrompt] = useState(""),
    [modal, setModal] = useState(false),
    [section, setSection] = useState<"general" | "models" | "prompt">("models"),
    [systemPromptBase, setSystemPromptBase] = useState<{ default: string; custom: string | null } | null>(null),
    [systemPromptDraft, setSystemPromptDraft] = useState(""),
    [systemPromptBusy, setSystemPromptBusy] = useState(false),
    [systemPromptSavedAt, setSystemPromptSavedAt] = useState(0),
    [workspaceEditing, setWorkspaceEditing] = useState(false),
    [workspaceSearch, setWorkspaceSearch] = useState(false),
    [projectDialog, setProjectDialog] = useState(false),
    [projectName, setProjectName] = useState(""),
    [projectPath, setProjectPath] = useState(""),
    [projectPicking, setProjectPicking] = useState(false),
    [query, setQuery] = useState(""),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set()),
    [permissionOpen, setPermissionOpen] = useState(false),
    [commandOpen, setCommandOpen] = useState(false),
    [activeSessionId, setActiveSessionId] = useState<string | null>(null),
    [adhdSessions, setAdhdSessions] = useState<Set<string>>(
      () =>
        new Set(
          Object.keys(localStorage)
            .filter((key) => key.startsWith("tcode.adhd.") && localStorage.getItem(key) === "1")
            .map((key) => key.slice("tcode.adhd.".length)),
        ),
    ),
    [adhdArmed, setAdhdArmed] = useState(false),
    [sessionMenuId, setSessionMenuId] = useState<string | null>(null),
    [editingProviderId, setEditingProviderId] = useState<string | null>(null),
    [providerDraft, setProviderDraft] = useState<MP | null>(null),
    [selectedProviderId, setSelectedProviderId] = useState(() => localStorage.getItem("tcode.providerId") ?? ""),
    [modelMenuOpen, setModelMenuOpen] = useState(false),
    [key, setKey] = useState(""),
    [discoveringModels, setDiscoveringModels] = useState(false),
    [credentialIds, setCredentialIds] = useState<Set<string>>(new Set()),
    [notice, setNotice] = useState(""),
    [sidebar, setSidebar] = useState(
      () => !window.matchMedia("(max-width: 900px)").matches,
    ),
    [details, setDetails] = useState(false),
    [detailsTab, setDetailsTab] = useState<"summary" | "raw" | "source">("summary"),
    [trajectoryQuery, setTrajectoryQuery] = useState(""),
    [enterBehavior, setEnterBehavior] = useState<"queue" | "steer">(() => localStorage.getItem("tcode.enterBehavior") === "steer" ? "steer" : "queue"),
    [enterMenuOpen, setEnterMenuOpen] = useState(false),
    [languageMenuOpen, setLanguageMenuOpen] = useState(false),
    [contextOpen, setContextOpen] = useState(false),
    [showScrollBottom, setShowScrollBottom] = useState(false),
    [sendNotice, setSendNotice] = useState(""),
    [view, setView] = useState<"chat" | "trajectory">("chat");
  const [run, setRun] = useState<R | null>(null),
    [runs, setRuns] = useState<R[]>([]),
    [sessions, setSessions] = useState<S[]>([]),
    [archivedSessions, setArchivedSessions] = useState<S[]>([]),
    [archivedOpen, setArchivedOpen] = useState(false),
    [archivedSelected, setArchivedSelected] = useState<Set<string>>(new Set()),
    [workspaces, setWorkspaces] = useState<W[]>([]),
    [modelProviders, setModelProviders] = useState<MP[]>([]),
    [events, setEvents] = useState<E[]>([]),
    // Conversation events from earlier runs in the same session, shown above
    // the current run's chat so history survives across runs.
    [priorEvents, setPriorEvents] = useState<E[]>([]),
    [selected, setSelected] = useState<E | null>(null),
    [approvals, setApprovals] = useState<A[]>([]),
    [error, setError] = useState(""),
    [sending, setSending] = useState(false);
  const stream = useRef<EventSource | null>(null),
    scroll = useRef<HTMLDivElement | null>(null),
    stickToBottom = useRef(true),
    wsControlRef = useRef<HTMLDivElement | null>(null),
    [wsMenuHeight, setWsMenuHeight] = useState(0),
    active = !!(
      run && ["queued", "running", "waiting_approval"].includes(run.status)
    );
  const refresh = async () => {
    try {
      let [r, c, w, sessionResponse, archivedResponse, profileResponse] = await Promise.all([
        fetch("/api/runs"),
        fetch("/api/credentials"),
        fetch("/api/workspaces"),
        fetch("/api/sessions"),
        fetch("/api/sessions?archived=1"),
        fetch("/api/model-profiles"),
      ]);
      if (r.ok) setRuns(await r.json());
      if (w.ok) setWorkspaces(await w.json());
      if (sessionResponse.ok) setSessions(await sessionResponse.json());
      if (archivedResponse.ok) setArchivedSessions(await archivedResponse.json());
      if (profileResponse.ok) setModelProviders(await profileResponse.json());
      if (c.ok) {
        let x = await c.json();
        setCredentialIds(new Set(x.filter((v: any) => v.configured).map((v: any) => v.id)));
      }
    } catch {}
  };
  const openRun = async (id: string) => {
    stickToBottom.current = true;
    setShowScrollBottom(false);
    stream.current?.close();
    let r = await fetch("/api/runs/" + id);
    if (!r.ok) return;
    const opened = await r.json();
    // Prefetch all data before touching state so the hero→chat switch
    // never paints an empty chat in between (no "flash" on send).
    const replay = await fetch(`/api/runs/${id}/events.json`);
    const replayEvents: E[] = replay.ok ? await replay.json() : [];
    let prior: E[] = [];
    if (opened.task.sessionId) {
      const priorRuns = runs
        .filter((item) => item.task.sessionId === opened.task.sessionId && item.id !== id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const pr of priorRuns) {
        const evResp = await fetch(`/api/runs/${pr.id}/events.json`);
        if (!evResp.ok) continue;
        const evs: E[] = await evResp.json();
        prior.push(...evs);
      }
    }
    // Commit everything in one batch so React renders the full chat at once.
    setRun(opened);
    const recordedProvider = modelProviders.find((item) => item.baseUrl === opened.task.modelProfile.baseUrl && item.models.some((model) => model.id === opened.task.modelProfile.model));
    setSelectedProviderId(recordedProvider?.id ?? "");
    setActiveSessionId(opened.task.sessionId ?? null);
    setS((current) => ({
      ...current,
      workspace: opened.task.workspace,
      permissionMode: opened.task.permissionMode,
      baseUrl: opened.task.modelProfile.baseUrl,
      model: opened.task.modelProfile.model,
      protocol: opened.task.modelProfile.protocol,
      reasoningEffort: opened.task.modelProfile.reasoningEffort ?? "",
      contextBudget: opened.task.modelProfile.contextBudget,
    }));
    setEvents(replayEvents);
    setPriorEvents(prior);
    setSelected(null);
    let es = new EventSource(`/api/runs/${id}/events`);
    stream.current = es;
    es.onmessage = (m) =>
      setEvents((old) => {
        let e = JSON.parse(m.data);
        return old.some((x) => x.seq === e.seq) ? old : [...old, e];
      });
  };
  useEffect(() => {
    void refresh();
    let timer = setInterval(async () => {
      await refresh();
      if (run)
        try {
          let r = await fetch(`/api/runs/${run.id}`);
          if (r.ok) setRun(await r.json());
          let eventResponse = await fetch(`/api/runs/${run.id}/events.json`);
          if (eventResponse.ok) {
            const snapshot = await eventResponse.json();
            setEvents((old) => mergeEvents(old, snapshot));
          }
          let p = await fetch(`/api/approvals?runId=${run.id}`);
          if (p.ok) setApprovals(await p.json());
        } catch {}
    }, 1200);
    return () => {
      clearInterval(timer);
      stream.current?.close();
    };
  }, [run?.id]);
  useEffect(() => {
    localStorage.setItem("tcode.locale", lang);
  }, [lang]);
  useEffect(() => {
    localStorage.setItem("tcode.providerId", selectedProviderId);
    localStorage.setItem("tcode.baseUrl", s.baseUrl);
    localStorage.setItem("tcode.model", s.model);
    localStorage.setItem("tcode.protocol", s.protocol);
    localStorage.setItem("tcode.enterBehavior", enterBehavior);
  }, [selectedProviderId, enterBehavior]);
  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest(".session-shell")) setSessionMenuId(null);
      if (!target?.closest(".workspace-control")) setWorkspaceEditing(false);
      if (!target?.closest(".permission-control")) setPermissionOpen(false);
      if (!target?.closest(".context-control")) setContextOpen(false);
      if (!target?.closest(".model-control")) setModelMenuOpen(false);
      if (!target?.closest(".composer")) setCommandOpen(false);
      if (!target?.closest(".enter-behavior-control")) setEnterMenuOpen(false);
      if (!target?.closest(".language-control")) setLanguageMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeMenus);
    return () => window.removeEventListener("pointerdown", closeMenus);
  }, []);
  useEffect(() => {
    if (selectedProviderId && modelProviders.some((item) => item.id === selectedProviderId)) return;
    const first = modelProviders[0];
    if (!first?.models[0]) return;
    setSelectedProviderId(first.id);
    setS((current) => ({ ...current, baseUrl: first.baseUrl, protocol: first.protocol, model: first.models[0].id, contextBudget: first.models[0].contextBudget ?? 120000, reasoningEffort: "" }));
  }, [modelProviders, selectedProviderId]);
  useEffect(() => {
    if (view === "chat" && stickToBottom.current)
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        behavior: "smooth",
      });
    else scroll.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [events.length, view]);
  useEffect(() => {
    if (!workspaceEditing) { setWsMenuHeight(0); return; }
    const measure = () => {
      const picker = wsControlRef.current?.querySelector(".workspace-picker");
      if (picker) setWsMenuHeight(picker.getBoundingClientRect().height);
    };
    measure();
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [workspaceEditing, workspaces.length]);
  const openSettings = (x: "general" | "models" | "prompt" = "models") => {
    setWorkspaceEditing(false);
    setPermissionOpen(false);
    setCommandOpen(false);
    setModelMenuOpen(false);
    setSessionMenuId(null);
    setSection(x);
    setModal(true);
    setNotice("");
    void loadSystemPrompt();
  };
  const loadSystemPrompt = async () => {
    try {
      const data = await fetch("/api/system-prompt").then((response) => response.json());
      setSystemPromptBase({ default: data.default, custom: data.custom });
      setSystemPromptDraft(data.effective);
    } catch {}
  };
  const saveSystemPrompt = async (text = systemPromptDraft) => {
    if (systemPromptBusy || !text.trim()) return;
    setSystemPromptBusy(true);
    try {
      const response = await fetch("/api/system-prompt", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "save failed");
      await loadSystemPrompt();
      setSystemPromptSavedAt(Date.now());
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSystemPromptBusy(false);
    }
  };
  const injectAdhdSkill = async () => {
    if (systemPromptBusy || !systemPromptBase) return;
    try {
      const { text } = await fetch("/api/adhd-skill").then((response) => response.json());
      const base = systemPromptDraft.trim() || (systemPromptBase.custom ?? systemPromptBase.default);
      const next = `${base}\n\n${text}`;
      setSystemPromptDraft(next);
      await saveSystemPrompt(next);
    } catch {}
  };
  const resetSystemPrompt = async () => {
    if (systemPromptBusy) return;
    setSystemPromptBusy(true);
    try {
      await fetch("/api/system-prompt", { method: "DELETE" });
      await loadSystemPrompt();
      setSystemPromptSavedAt(Date.now());
    } finally {
      setSystemPromptBusy(false);
    }
  };
  const beginProvider = () => {
    setProviderDraft({ id: "", name: "", baseUrl: "", protocol: "chat-completions", models: [] });
    setEditingProviderId("__new__");
    setKey("");
    setError("");
  };
  const editProvider = (item: MP) => {
    setProviderDraft(structuredClone(item));
    setEditingProviderId(item.id);
    setKey("");
    setError("");
  };
  const saveProvider = async () => {
    setError("");
    if (!providerDraft) return;
    const clean = { ...providerDraft, id: providerDraft.id.trim().toLowerCase().replace(/\s+/g, "-"), name: providerDraft.name.trim(), baseUrl: providerDraft.baseUrl.trim().replace(/\/+$/, ""), models: providerDraft.models.filter((item) => item.id.trim()).map((item) => ({ ...item, id: item.id.trim(), name: item.name?.trim() || undefined, contextBudget: item.contextBudget ? Number(item.contextBudget) : undefined, maxOutputTokens: item.maxOutputTokens ? Number(item.maxOutputTokens) : undefined })) };
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(clean.id)) { setError(lang === "zh" ? "提供商 ID 只能包含小写字母、数字、点、下划线和连字符，长度 1–64。" : "Provider ID must use 1–64 lowercase letters, numbers, dots, underscores, or hyphens."); return; }
    if (!clean.name) { setError(lang === "zh" ? "请输入显示名称。" : "Enter a display name."); return; }
    try { const url = new URL(clean.baseUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { setError(lang === "zh" ? "API 地址必须是有效的 HTTP 或 HTTPS URL。" : "API URL must be a valid HTTP or HTTPS URL."); return; }
    if (!clean.models.length) { setError(lang === "zh" ? "至少添加一个模型。" : "Add at least one model."); return; }
    if (key && (key !== key.trim() || !/^[\x21-\x7E]+$/.test(key) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(key) || ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))))) { setError(lang === "zh" ? "API 密钥格式无效：只粘贴密钥值，不要带变量名、引号或首尾空格。" : "Invalid API key format: paste only the key value without a variable name, quotes, or surrounding whitespace."); return; }
    const profileResponse = await fetch(`/api/model-profiles/${encodeURIComponent(clean.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(clean) });
    const profileBody = await profileResponse.json();
    if (!profileResponse.ok) { setError(lang === "zh" ? `提供商配置无效：${profileBody.error ?? "请检查输入字段"}` : (profileBody.error ?? "Invalid provider configuration")); return; }
    if (key) {
      let r = await fetch(`/api/credentials/${encodeURIComponent(clean.id)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: key }),
        }),
        b = await r.json();
      if (!r.ok) {
        setError(b.error);
        return;
      }
      setKey("");
    }
    setSelectedProviderId(clean.id);
    const model = clean.models[0];
    setS((current) => ({ ...current, baseUrl: clean.baseUrl, protocol: clean.protocol, model: model.id, contextBudget: model.contextBudget ?? 120000, reasoningEffort: "" }));
    setEditingProviderId(null);
    setProviderDraft(null);
    setNotice(lang === "zh" ? "提供商已保存" : "Provider saved");
    await refresh();
  };
  const discoverProviderModels = async () => {
    if (!providerDraft?.baseUrl.trim()) return;
    setDiscoveringModels(true);
    setError("");
    try {
      const response = await fetch("/api/model-profiles/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: providerDraft.baseUrl.trim(),
          credentialId: editingProviderId === "__new__" ? undefined : providerDraft.id,
          apiKey: key || undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) { setError(body.error); return; }
      setProviderDraft({ ...providerDraft, models: body.models });
    } finally {
      setDiscoveringModels(false);
    }
  };
  const addWorkspace = async (path: string, title?: string) => {
    const response = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, title }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error);
      return false;
    }
    setS((current) => ({ ...current, workspace: body.path }));
    setWorkspaceEditing(false);
    await refresh();
    return true;
  };
  const openProjectDialog = () => {
    setWorkspaceEditing(false);
    setPermissionOpen(false);
    setCommandOpen(false);
    setModelMenuOpen(false);
    setSessionMenuId(null);
    setProjectName("");
    setProjectPath("");
    setError("");
    setProjectDialog(true);
  };
  const chooseProjectFolder = async () => {
    setProjectPicking(true);
    setError("");
    try {
      const response = await fetch("/api/select-directory", { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error);
        return;
      }
      if (body.path) {
        const path = String(body.path);
        setProjectPath(path);
        setProjectName((current) => current || path.split(/[\\/]/).filter(Boolean).at(-1) || "");
      }
    } finally {
      setProjectPicking(false);
    }
  };
  const createProject = async () => {
    if (!projectName.trim() || !projectPath) return;
    setError("");
    if (await addWorkspace(projectPath, projectName.trim())) setProjectDialog(false);
  };
  const toggleSet = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    id: string,
  ) =>
    setter((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const createSession = async (workspacePath = s.workspace) => {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspacePath, permissionMode: s.permissionMode }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error);
      return null;
    }
    stream.current?.close();
    setRun(null);
    setEvents([]);
    setSelected(null);
    setDetails(false);
    setPrompt("");
    setActiveSessionId(body.id);
    // Transfer pre-session ADHD arm onto the newly created session.
    setAdhdArmed((armed) => {
      if (armed) {
        localStorage.setItem(`tcode.adhd.${body.id}`, "1");
        setAdhdSessions((prev) => new Set(prev).add(body.id));
      }
      return false;
    });
    setS((current) => ({ ...current, workspace: workspacePath }));
    await refresh();
    return body.id as string;
  };
  const openSession = async (session: S) => {
    setSelected(null);
    setDetails(false);
    setActiveSessionId(session.id);
    setS((current) => ({
      ...current,
      workspace: session.workspacePath,
      permissionMode: session.permissionMode,
    }));
    const latest = runs.find((item) => item.task.sessionId === session.id);
    if (latest) await openRun(latest.id);
    else {
      stream.current?.close();
      setRun(null);
      setEvents([]);
      setPrompt("");
      stickToBottom.current = true;
      setShowScrollBottom(false);
    }
  };
  const choosePermission = async (permissionMode: string) => {
    setS({ ...s, permissionMode });
    setPermissionOpen(false);
    if (activeSessionId)
      await fetch(`/api/sessions/${activeSessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissionMode }),
      });
    await refresh();
  };
  const archiveSession = async (id: string) => {
    await fetch(`/api/sessions/${id}/archive`, { method: "POST" });
    if (activeSessionId === id) fresh();
    setSessionMenuId(null);
    await refresh();
  };
  const restoreSession = async (id: string) => {
    const response = await fetch(`/api/sessions/${id}/restore`, { method: "POST" });
    if (!response.ok) setError((await response.json()).error ?? "Restore failed");
    setArchivedSelected((current) => { const next = new Set(current); next.delete(id); return next; });
    await refresh();
  };
  const deleteArchived = async (ids: string[]) => {
    if (!ids.length) return;
    const message = lang === "zh"
      ? `永久删除 ${ids.length} 个已归档会话及其运行、轨迹？此操作无法撤销。`
      : `Permanently delete ${ids.length} archived session(s), including their runs and traces? This cannot be undone.`;
    if (!window.confirm(message)) return;
    const response = await fetch("/api/sessions/archived", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const body = await response.json();
    if (!response.ok) { setError(body.error ?? "Archive deletion failed"); return; }
    setArchivedSelected(new Set());
    await refresh();
  };
  const forkSession = async (id: string) => {
    const response = await fetch(`/api/sessions/${id}/fork`, {
      method: "POST",
    });
    const body = await response.json();
    setSessionMenuId(null);
    await refresh();
    if (response.ok) await openSession(body);
  };
  const removeProvider = async (id: string) => {
    await fetch(`/api/model-profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    setEditingProviderId(null);
    setProviderDraft(null);
    if (selectedProviderId === id) setSelectedProviderId("");
    await refresh();
  };
  const start = async (content = prompt.trim()) => {
    if (!content) return;
    setSending(true);
    try {
    const provider = modelProviders.find((item) => item.id === selectedProviderId);
    const configured = provider && credentialIds.has(provider.id) && provider.baseUrl === s.baseUrl && provider.protocol === s.protocol && provider.models.some((model) => model.id === s.model);
    if (!configured) {
      setError(provider && credentialIds.has(provider.id) ? (lang === "zh" ? "当前模型与提供商配置不一致，请重新选择模型。" : "The selected model does not match its provider. Select the model again.") : t.keyFirst);
      openSettings();
      return;
    }
    const providerModel = provider!.models.find((model) => model.id === s.model);
    await fetch("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: s.workspace }),
    });
    const sessionId = activeSessionId ?? (await createSession(s.workspace));
    if (!sessionId) return;
    // Carry the pre-session toggle onto the session this run creates.
    let adhdForRun = adhdSessions.has(sessionId);
    if (!activeSessionId && adhdArmed) {
      localStorage.setItem(`tcode.adhd.${sessionId}`, "1");
      setAdhdSessions((prev) => new Set(prev).add(sessionId));
      setAdhdArmed(false);
      adhdForRun = true;
    }
    let task: any = {
      sessionId,
      prompt: content,
      workspace: s.workspace,
      modelProfile: {
        baseUrl: s.baseUrl,
        model: s.model,
        protocol: s.protocol,
        maxOutputTokens: providerModel?.maxOutputTokens ?? 8192,
        contextBudget: +s.contextBudget,
      },
      setup: [],
      grader: [],
      timeout: 1800000,
      toolTimeout: 120000,
      permissionMode: s.permissionMode,
      network: s.network,
      maxTurns: +s.maxTurns,
      variant: "web",
    };
    if (s.reasoningEffort)
      task.modelProfile.reasoningEffort = s.reasoningEffort;
    let r = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task, credentialId: selectedProviderId, adhd: adhdForRun }),
      }),
      b = await r.json();
    if (!r.ok) {
      setError(b.error);
      return;
    }
    setPrompt("");
    await openRun(b.id);
    } finally { setSending(false); }
  };
  const adhdActive = activeSessionId ? adhdSessions.has(activeSessionId) : adhdArmed;
  const toggleAdhd = () => {
    if (activeSessionId) {
      const on = !adhdSessions.has(activeSessionId);
      localStorage.setItem(`tcode.adhd.${activeSessionId}`, on ? "1" : "0");
      setAdhdSessions((prev) => {
        const next = new Set(prev);
        if (on) next.add(activeSessionId);
        else next.delete(activeSessionId);
        return next;
      });
    } else {
      setAdhdArmed(!adhdArmed);
    }
  };
  const submitPrompt = async (mode = enterBehavior) => {
    const content = prompt.trim();
    if (!content || sending) return;
    if (!active || !run) {
      await start(content);
      return;
    }
    const response = await fetch(`/api/runs/${run.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, mode }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error);
      return;
    }
    setPrompt("");
    setSendNotice(mode === "queue" ? (lang === "zh" ? "消息已排队" : "Message queued") : (lang === "zh" ? "消息将在下一步插入" : "Message will steer the next step"));
    window.setTimeout(() => setSendNotice(""), 1800);
  };
  const rateMessage = async (seq: number, rating: "up" | "down") => {
    if (!run) return;
    const response = await fetch(`/api/runs/${run.id}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq, rating }),
    });
    if (!response.ok) setError((await response.json()).error);
  };
  const fresh = () => {
      stream.current?.close();
      setRun(null);
      setEvents([]);
      setPriorEvents([]);
      setPrompt("");
      setWorkspaceEditing(false);
      setPermissionOpen(false);
      setCommandOpen(false);
      setModelMenuOpen(false);
      setSessionMenuId(null);
      setActiveSessionId(null);
      setSelected(null);
      setDetails(false);
    },
    decide = async (id: string, allow: boolean, remember = false) => {
      await fetch("/api/approvals/" + id, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allow, remember }),
      });
      setApprovals((x) => x.filter((a) => a.id !== id));
    },
    results = useMemo(
      () =>
        new Map(
          events
            .filter((e) => e.type === "tool_result")
            .map((e) => [e.data.toolCallId, e]),
        ),
      [events],
    ),
    chat = events.filter((e) =>
      ["user_message", "model_response", "tool_call", "run_failed"].includes(e.type),
    ),
    priorResults = useMemo(
      () =>
        new Map(
          priorEvents
            .filter((e) => e.type === "tool_result")
            .map((e) => [e.data.toolCallId, e]),
        ),
      [priorEvents],
    ),
    priorChat = priorEvents.filter((e) =>
      ["user_message", "model_response", "tool_call", "run_failed"].includes(e.type),
    ),
    usage = events.filter((e) => e.type === "model_response").reduce((sum, e) => ({
      inputTokens: sum.inputTokens + Number(e.data.usage?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + Number(e.data.usage?.outputTokens ?? 0),
      totalTokens: sum.totalTokens + Number(e.data.usage?.totalTokens ?? 0),
      cachedInputTokens: sum.cachedInputTokens + Number(e.data.usage?.cachedInputTokens ?? 0),
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 }),
    turnCount = events.filter((e) => e.type === "model_response").length,
    toolCount = events.filter((e) => e.type === "tool_call").length,
    performance = runPerformance(events),
    cachePercent = usage.inputTokens ? Math.min(100, Math.round((usage.cachedInputTokens / usage.inputTokens) * 100)) : 0,
    latestUsage = [...events].reverse().find((e) => e.type === "model_response")?.data.usage,
    latestRequest = [...events].reverse().find((e) => e.type === "model_request"),
    startedEvent = events.find((e) => e.type === "run_started"),
    contextBreakdown = (() => {
      const messages = Array.isArray(latestRequest?.data.messages) ? latestRequest.data.messages : [];
      const system = messages.filter((message: any) => message.role === "system");
      const dialog = messages.filter((message: any) => message.role !== "system");
      return {
        system: estimateDisplayTokens(system.length ? system : startedEvent?.data.systemPrompt),
        tools: estimateDisplayTokens(startedEvent?.data.tools),
        dialog: estimateDisplayTokens(dialog),
      };
    })(),
    currentContextTokens = Math.max(
      Number(latestUsage?.totalTokens ?? (Number(latestUsage?.inputTokens ?? 0) + Number(latestUsage?.outputTokens ?? 0))),
      contextBreakdown.system + contextBreakdown.tools + contextBreakdown.dialog,
    ),
    feedback = new Map(events.filter((e) => e.type === "message_feedback").map((e) => [Number(e.data.seq), String(e.data.rating)])),
    artifacts = run ? Array.from(new Set(events.filter((e) => e.type === "tool_call" && e.data.name === "str_replace_editor" && ["create", "str_replace", "insert"].includes(String(e.data.input?.command)) && !String(results.get(e.data.id)?.data.output ?? "").startsWith("Error:")).map((e) => String(e.data.input?.path ?? "")).filter((path) => path && insideWorkspace(run.task.workspace, path)))) : [],
    elapsedMs = run ? Math.max(0, new Date(events.at(-1)?.at ?? new Date().toISOString()).getTime() - new Date(run.createdAt).getTime()) : 0,
    contextPercent = Math.min(100, Math.round((currentContextTokens / Number(run?.task.modelProfile.contextBudget ?? s.contextBudget)) * 100)),
    trajectorySegments = (() => {
      if (!events.length) return [] as { seq: number; lane: "input" | "model" | "tools"; left: number; width: number; event: E }[];
      const start = eventTime(events[0]);
      const end = Math.max(start + 1, eventTime(events.at(-1)));
      const span = end - start;
      return events.flatMap((event) => {
        let lane: "input" | "model" | "tools" | null = null;
        let finish = event;
        if (event.type === "user_message" || event.type === "user_message_queued") lane = "input";
        else if (event.type === "model_request") {
          lane = "model";
          finish = events.find((candidate) => candidate.seq > event.seq && candidate.type === "model_response") ?? event;
        } else if (event.type === "tool_call") {
          lane = "tools";
          finish = events.find((candidate) => candidate.type === "tool_result" && candidate.data.toolCallId === event.data.id) ?? event;
        }
        if (!lane) return [];
        const left = ((eventTime(event) - start) / span) * 100;
        const width = Math.max(0.7, ((Math.max(eventTime(finish), eventTime(event) + 1) - eventTime(event)) / span) * 100);
        return [{ seq: event.seq, lane, left: Math.min(99.3, left), width: Math.min(100 - left, width), event }];
      });
    })(),
    lastResponseSeq = Math.max(0, ...events.filter((e) => e.type === "model_response").map((e) => e.seq)),
    streamedText = events.filter((e) => e.type === "model_delta" && e.seq > lastResponseSeq).map((e) => String(e.data.text ?? "")).join(""),
    visibleTrajectory = events.filter((e) => !trajectoryQuery.trim() || `${e.type} ${JSON.stringify(e.data)}`.toLowerCase().includes(trajectoryQuery.toLowerCase())),
    configured = Boolean(selectedProviderId && credentialIds.has(selectedProviderId)),
    selectedProvider = modelProviders.find((item) => item.id === selectedProviderId),
    selectedModel = selectedProvider?.models.find((item) => item.id === s.model),
    selectedInspection = selected ? eventInspection(events, selected) : null;
  return (
    <div
      className={`app ${sidebar ? "" : "sidebar-off"} ${details ? "details-on" : ""}`}
    >
      <aside className="sidebar">
        <div className="brand-row">
          <button className="brand" onClick={fresh}>
            <TCodeBrand />
          </button>
          <button className="icon-btn" onClick={() => setSidebar(false)}>
            <span className="sr-only">{lang === "zh" ? "收起侧栏" : "Collapse sidebar"}</span>
            <I name="panel" />
          </button>
        </div>
        <button className="new-session" onClick={() => void createSession()}>
          <I name="plus" />
          {t.new}
        </button>
        <div className="session-title workspace-toolbar">
          {workspaceSearch ? (
            <div className="workspace-search">
              <I name="search" />
              <input
                autoFocus
                placeholder={lang === "zh" ? "搜索" : "Search"}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button
                onClick={() => {
                  setQuery("");
                  setWorkspaceSearch(false);
                }}
              >
                ×
              </button>
            </div>
          ) : (
            <>
              <span>{lang === "zh" ? "工作区" : "Workspaces"}</span>
              <button
                title={lang === "zh" ? "搜索" : "Search"}
                onClick={() => setWorkspaceSearch(true)}
              >
                <I name="search" />
              </button>
              <button
                title={lang === "zh" ? "创建项目" : "Create project"}
                onClick={openProjectDialog}
              >
                <I name="folderPlus" />
              </button>
            </>
          )}
        </div>
        <div className="sessions">
          {workspaces
            .filter(
              (workspace) =>
                !query.trim() ||
                workspace.title.toLowerCase().includes(query.toLowerCase()) ||
                workspace.path.toLowerCase().includes(query.toLowerCase()) ||
                sessions.some(
                  (item) =>
                    item.workspacePath.toLowerCase() ===
                      workspace.path.toLowerCase() &&
                    item.title.toLowerCase().includes(query.toLowerCase()),
                ),
            )
            .map((workspace) => {
              const children = sessions.filter(
                (item) =>
                  item.workspacePath.toLowerCase() ===
                    workspace.path.toLowerCase() &&
                  (!item.blank || item.id === activeSessionId) &&
                  (!query.trim() ||
                    item.title.toLowerCase().includes(query.toLowerCase()) ||
                    workspace.title
                      .toLowerCase()
                      .includes(query.toLowerCase())),
              );
              const isCollapsed = collapsed.has(workspace.id) && !query.trim();
              const visibleChildren = children;
              return (
                <section className="workspace-group" key={workspace.id}>
                  <button
                    className="workspace-row"
                    onClick={() => {
                      toggleSet(setCollapsed, workspace.id);
                    }}
                    title={workspace.path}
                  >
                    <span className="workspace-folder"><I name="folder" /></span>
                    <span>
                      <strong>{workspace.title}</strong>
                    </span>
                    <span
                      className="workspace-new"
                      title={t.new}
                      onClick={(event) => {
                        event.stopPropagation();
                        void createSession(workspace.path);
                      }}
                    >
                      <I name="plus" />
                    </span>
                    <span className={isCollapsed ? "workspace-chevron collapsed" : "workspace-chevron"}><I name="down" /></span>
                  </button>
                  <div className={`workspace-sessions${isCollapsed ? " collapsed" : ""}${sessionMenuId && children.some((item) => item.id === sessionMenuId) ? " menu-open" : ""}`} style={{ maxHeight: isCollapsed ? 0 : `${visibleChildren.length * 36}px` }}>
                    {visibleChildren.map((session) => {
                      const latestRun = runs.find(
                        (item) => item.task.sessionId === session.id,
                      );
                      return (
                        <div className="session-shell" key={session.id}>
                          <div
                            className={
                              activeSessionId === session.id
                                ? "current session-row"
                                : "session-row"
                            }
                            title={session.title}
                          >
                            <button className="session-main" onClick={() => void openSession(session)}>
                              <I name="chatBubble" />
                              <strong>
                                {session.blank ? t.new : session.title}
                              </strong>
                            </button>
                            <small>
                              {session.blank
                                ? ""
                                : new Date(session.updatedAt).toLocaleDateString(lang === "zh" ? "zh-CN" : "en", { month: "numeric", day: "numeric" })}
                            </small>
                            <button className="session-more" aria-label={lang === "zh" ? "会话操作" : "Session actions"}
                              onClick={(event) => {
                                event.stopPropagation();
                                setWorkspaceEditing(false);
                                setPermissionOpen(false);
                                setCommandOpen(false);
                                setModelMenuOpen(false);
                                setSessionMenuId(
                                  sessionMenuId === session.id
                                    ? null
                                    : session.id,
                                );
                              }}
                            >
                              •••
                            </button>
                          </div>
                          {sessionMenuId === session.id && (
                            <div className="session-menu">
                              <button
                                onClick={() => void forkSession(session.id)}
                              >
                                <I name="fork" />
                                {lang === "zh" ? "派生会话" : "Fork session"}
                              </button>
                              <button
                                onClick={() => void archiveSession(session.id)}
                              >
                                <I name="archive" />
                                {lang === "zh" ? "归档" : "Archive"}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          {!sessions.length && <p>{t.none}</p>}
        </div>
        <button className="settings-link" onClick={() => openSettings()}>
          <I name="settings" />
          <span>{t.settings}</span>
        </button>
      </aside>
      <main className="conversation">
        <header className={run ? "topbar" : "topbar new-session-topbar"}>
          {!sidebar && (
            <button
              className="icon-btn open-sidebar"
              onClick={() => setSidebar(true)}
              aria-label={lang === "zh" ? "展开侧栏" : "Open sidebar"}
            >
              <I name="panel" />
            </button>
          )}
          <div className="run-title">
            <strong>{run ? run.task.prompt.slice(0, 56) : t.new}</strong>
          </div>
          <nav>
            <button
              className={view === "chat" ? "active" : ""}
              onClick={() => setView("chat")}
            >
              {t.chat}
            </button>
            <button
              className={view === "trajectory" ? "active" : ""}
              onClick={() => setView("trajectory")}
            >
              {t.trajectory}
            </button>
          </nav>
          <div className="top-actions">
            {run ? <a className="session-log" href={`/api/runs/${run.id}/export`}><span>{lang === "zh" ? "会话日志" : "Session log"}</span><I name="download" /></a> : <button onClick={() => openSettings()}>{configured ? s.model : t.models}</button>}
            <button className="icon-btn" aria-label={lang === "zh" ? "运行详情" : "Run details"} onClick={() => setDetails(!details)}>
              •••
            </button>
          </div>
        </header>
        <div className="scroll" ref={scroll} onScroll={(event) => {
          const element = event.currentTarget;
          const away = element.scrollHeight - element.scrollTop - element.clientHeight > 120;
          stickToBottom.current = !away;
          setShowScrollBottom(away && view === "chat");
        }}>
          {!run && (
            <div className="hero">
              <div className="hero-title"><TCodeBrand markOnly /><h1>{lang === "zh" ? "开始新会话" : "Start a new session"}</h1></div>
              <div className="hero-controls">
                <div className="workspace-control" ref={wsControlRef}>
                  <button onClick={() => {
                    const next = !workspaceEditing;
                    setPermissionOpen(false);
                    setCommandOpen(false);
                    setModelMenuOpen(false);
                    setSessionMenuId(null);
                    setWorkspaceEditing(next);
                    if (!next) setWsMenuHeight(0);
                  }}>
                    <I name="folder" />
                    <span>{workspaces.find((w) => w.path.toLowerCase() === s.workspace.toLowerCase())?.title ?? s.workspace.split(/[\\/]/).filter(Boolean).at(-1)}</span>
                    <I name="down" />
                  </button>
                  {workspaceEditing && (
                    <div className="workspace-picker">
                      {workspaces.map((workspace) => (
                        <button
                          className="workspace-option"
                          key={workspace.id}
                          onClick={() => {
                            setS({ ...s, workspace: workspace.path });
                            setWorkspaceEditing(false);
                          }}
                        >
                          <I name="folder" />
                          <span>
                            <b>{workspace.title}</b>
                            <small>{workspace.path}</small>
                          </span>
                        </button>
                      ))}
                      <button className="workspace-add-row" onClick={openProjectDialog}><I name="folderPlus" /><span>{lang === "zh" ? "创建项目…" : "Create project…"}</span></button>
                    </div>
                  )}
                </div>
              </div>
              <div className="hero-composer-slot" />
            </div>
          )}
          {run && view === "chat" && (
            <div className="chat">
              <div className="context-row"><I name="document" /><span>{lang === "zh" ? "上下文注入" : "Context"}</span><b>·</b><code>TCode system prompt</code></div>
              {priorChat.map((e) =>
                e.type === "user_message" ? (
                  <div className="user-message" key={`p${e.runId ?? ""}-${e.seq}`}>
                    <div className="user"><span>{String(e.data.content ?? "")}</span></div>
                    <CopyAction text={String(e.data.content ?? "")} label="" />
                  </div>
                ) : e.type === "tool_call" ? (
                  <Tool
                    key={`p${e.runId ?? ""}-${e.seq}`}
                    e={e}
                    result={priorResults.get(e.data.id)}
                    onPick={() => {
                      setSelected(e);
                      setDetails(true);
                    }}
                  />
                ) : e.type === "model_response" && (e.data.content || e.data.reasoning) ? (
                  <div className="response-block" key={`p${e.runId ?? ""}-${e.seq}`}>
                    {e.data.reasoning && <details className="reasoning-row"><summary><I name="spark" /><span>Think</span><b>·</b><em>{String(e.data.reasoning).slice(0, 130)}</em></summary><p>{e.data.reasoning}</p></details>}
                    {e.data.content && <div className="assistant-response"><Markdown text={String(e.data.content)} /><div className="message-actions"><CopyAction text={String(e.data.content)} label="" /><time>{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div></div>}
                  </div>
                ) : e.type === "run_failed" ? (
                  <div className="run-error" key={`p${e.runId ?? ""}-${e.seq}`}>
                    <strong>{t.stopped}</strong>
                    {e.data.error}
                  </div>
                ) : null,
              )}
              {chat.map((e) =>
                e.type === "user_message" ? (
                  <div className="user-message" key={e.seq}>
                    <div className="user"><span>{String(e.data.content ?? "")}</span></div>
                    <CopyAction text={String(e.data.content ?? "")} label="" />
                  </div>
                ) : e.type === "tool_call" ? (
                  <Tool
                    key={e.seq}
                    e={e}
                    result={results.get(e.data.id)}
                    onPick={() => {
                      setSelected(e);
                      setDetails(true);
                    }}
                  />
                ) : e.type === "model_response" && (e.data.content || e.data.reasoning) ? (
                  <div className="response-block" key={e.seq}>
                    {e.data.reasoning && <details className="reasoning-row"><summary><I name="spark" /><span>Think</span><b>·</b><em>{String(e.data.reasoning).slice(0, 130)}</em></summary><p>{e.data.reasoning}</p></details>}
                    {e.data.content && <div className="assistant-response"><Markdown text={String(e.data.content)} />{(() => { const metric = responsePerformance(events, e); return <div className="message-actions">{!active && <><CopyAction text={String(e.data.content)} label="" /><button className={feedback.get(e.seq) === "up" ? "selected" : ""} title={lang === "zh" ? "有帮助" : "Helpful"} onClick={() => void rateMessage(e.seq, "up")}><I name="thumbsUp" /></button><button className={feedback.get(e.seq) === "down" ? "selected" : ""} title={lang === "zh" ? "没帮助" : "Not helpful"} onClick={() => void rateMessage(e.seq, "down")}><I name="thumbsDown" /></button></>}<time>{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{metric && <><span>· {lang === "zh" ? "耗时" : "duration"} {formatDuration(metric.durationMs)}</span>{metric.firstTokenMs > 0 && <span>· {lang === "zh" ? "首 token" : "first token"} {formatDuration(metric.firstTokenMs)}</span>}{metric.tokensPerSecond > 0 && <span>· {metric.tokensPerSecond.toFixed(1)} tok/s</span>}<span>· {metric.outputTokens} tok</span></>}</div>; })()}</div>}
                  </div>
                ) : e.type === "run_failed" ? (
                  <div className="run-error" key={e.seq}>
                    <strong>{t.stopped}</strong>
                    {e.data.error}
                  </div>
                ) : null,
              )}
              {!!artifacts.length && <div className="artifacts"><span>{lang === "zh" ? "产物" : "Artifacts"}</span>{artifacts.map((path) => <a key={path} href={`/api/runs/${run.id}/artifact?path=${encodeURIComponent(path)}`}><I name="download" />{path.split(/[\\/]/).at(-1)}</a>)}</div>}
              {active && (
                <div className="thinking">
                  <RoseLoader />
                  <div>{streamedText ? <p className="streamed-text">{streamedText}</p> : <><strong>{lang === "zh" ? "正在深入处理…" : "Deep diving…"}</strong><span>{t.working} · {toolCount} {t.tools}</span></>}</div>
                </div>
              )}
              {!active && run.error && !events.some((e) => e.type === "run_failed") && (
                <div className="run-error">
                  <strong>{t.failed}</strong>
                  {run.error}
                </div>
              )}
            </div>
          )}
          {run && view === "trajectory" && (
            <div className="trajectory-dashboard">
              <div className="trajectory-summary">
                <span><I name="clock" />{lang === "zh" ? "耗时" : "Duration"} <b>{formatDuration(elapsedMs)}</b></span>
                <span>{lang === "zh" ? "轮次" : "Turns"} <b>{turnCount}</b></span>
                <span>{lang === "zh" ? "调用" : "Calls"} <b>{toolCount}</b></span>
                <label><I name="search" /><input value={trajectoryQuery} onChange={(e) => setTrajectoryQuery(e.target.value)} placeholder={lang === "zh" ? "搜索轨迹" : "Search trajectory"} /></label>
              </div>
              <div className="trajectory-lanes">
                {(["Input", "Model", "Tools"] as const).map((lane) => <div className={`lane lane-${lane.toLowerCase()}`} key={lane}><small>{lang === "zh" ? ({ Input: "输入", Model: "模型", Tools: "工具" } as const)[lane] : lane}</small><div className="lane-track">{trajectorySegments.filter((segment) => segment.lane === lane.toLowerCase()).map((segment) => <button key={segment.seq} title={`${eventDisplayName(segment.event.type, lang)} · ${new Date(segment.event.at).toLocaleTimeString()}`} style={{ left: `${segment.left}%`, width: `${segment.width}%` }} onClick={() => { setSelected(segment.event); setDetails(true); }} />)}</div></div>)}
              </div>
              <div className="trajectory-list">
              {visibleTrajectory.map((e) => {
                const category = ["run_started", "summary"].includes(e.type) ? "CONTEXT" : e.type.startsWith("tool_") ? "TOOL" : e.type.startsWith("model_") ? "MODEL" : e.type.startsWith("run_") ? "SYSTEM" : "EVENT";
                const categoryLabel = lang === "zh" ? ({ CONTEXT: "上下文", TOOL: "工具", MODEL: "模型", SYSTEM: "系统", EVENT: "事件" } as const)[category] : category;
                const rawPreview = e.data.content ?? e.data.reasoning ?? e.data.input ?? e.data.output ?? e.data.error ?? e.data.model ?? e.data.request ?? "";
                const preview = typeof rawPreview === "string" ? rawPreview : JSON.stringify(rawPreview);
                return (
                <button
                  className={selected?.seq === e.seq ? "selected" : ""}
                  key={e.seq}
                  onClick={() => {
                    setSelected(e);
                    setDetails(true);
                  }}
                >
                  <span className={`event-chip ${category.toLowerCase()}`}>{categoryLabel}</span>
                  <strong>{eventDisplayName(e.type, lang)}</strong>
                  <time>{new Date(e.at).toLocaleTimeString()}</time>
                  <p>{preview.slice(0, 180)}</p>
                </button>
              )})}
              </div>
            </div>
          )}
        </div>
        {showScrollBottom && run && view === "chat" && <button className="scroll-bottom" aria-label={lang === "zh" ? "滚动到底部" : "Scroll to bottom"} onClick={() => {
          stickToBottom.current = true;
          scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
          setShowScrollBottom(false);
        }}><I name="down" /></button>}
        <div className={run ? "composer-seat" : `composer-seat hero-seat${workspaceEditing ? " workspace-menu-open" : ""}${error && !modal ? " has-error" : ""}${permissionOpen || modelMenuOpen || commandOpen || contextOpen ? " floating-menu-open" : ""}`} style={!run && workspaceEditing && wsMenuHeight ? { transform: `translateY(${(error && !modal ? 164 : 119) + wsMenuHeight + 12}px)` } : undefined}>
          {approvals.map((a) => (
            <div className={a.danger ? "approval danger" : "approval"} key={a.id}>
              <header>
                <strong>{a.danger ? (lang === "zh" ? "工作区外写入审批" : "Out-of-workspace write") : t.approval}</strong>
              </header>
              {a.danger && (
                <p className="approval-danger-note">
                  {lang === "zh"
                    ? "警告：目标路径在工作区之外，批准仅对本次写入生效！"
                    : "Warning: the target path is outside the workspace; approval covers only this single write!"}
                </p>
              )}
              <pre>{a.input}</pre>
              <footer>
                <button onClick={() => decide(a.id, false)}>{t.deny}</button>
                <button onClick={() => decide(a.id, true)}>{t.allow}</button>
                {!a.danger && a.approvalKey && <button onClick={() => decide(a.id, true, true)}>
                  {lang === "zh" ? "允许同类命令" : "Always allow similar"}
                </button>}
              </footer>
            </div>
          ))}
          {error && !modal && (
            <div className="composer-error">
              {error}
              <button onClick={() => openSettings()}>{t.open}</button>
            </div>
          )}
          <div className="composer">
            {commandOpen && (
              <div className="command-menu">
                <small>{lang === "zh" ? "操作" : "Actions"}</small>
                <button disabled={!run} onClick={() => { setPrompt(""); setCommandOpen(false); if (run) window.open(`/api/runs/${run.id}/export`, "_blank"); }}><b>export</b><span>{lang === "zh" ? "下载当前会话轨迹" : "Download this session trace"}</span></button>
                <button onClick={() => { setPrompt(""); setCommandOpen(false); setPermissionOpen(true); }}><b>permission</b><span>{lang === "zh" ? "切换权限预设" : "Switch permission preset"}</span></button>
                <button onClick={() => { setPrompt(""); setCommandOpen(false); openSettings(); }}><b>model</b><span>{lang === "zh" ? "配置本会话使用的模型" : "Configure the session model"}</span></button>
              </div>
            )}
            <textarea
              aria-label={t.message}
              placeholder={t.message}
              value={prompt}
              onChange={(e) => {
                const command = e.target.value.trimStart() === "/";
                setPrompt(e.target.value);
                setCommandOpen(command);
                if (command) {
                  setPermissionOpen(false);
                  setModelMenuOpen(false);
                  setWorkspaceEditing(false);
                  setSessionMenuId(null);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !sending) {
                  e.preventDefault();
                  const mode = active && (e.ctrlKey || e.metaKey) ? (enterBehavior === "queue" ? "steer" : "queue") : enterBehavior;
                  void submitPrompt(mode);
                }
              }}
            />
            {sendNotice && <div className="send-notice">{sendNotice}</div>}
            <footer>
              <button className="composer-plus" aria-label={lang === "zh" ? "打开命令" : "Open commands"} onClick={() => {
                setPrompt("/");
                setPermissionOpen(false);
                setModelMenuOpen(false);
                setWorkspaceEditing(false);
                setSessionMenuId(null);
                setCommandOpen(true);
              }}><I name="plus" /></button>
              <div className="permission-control">
                 <button
                   className="composer-select"
                   aria-label={
                     s.permissionMode === "danger-full-access"
                       ? t.fullMode
                       : s.permissionMode === "read-only"
                         ? t.askMode
                         : t.reviewMode
                   }
                   onClick={() => {
                    const next = !permissionOpen;
                    setCommandOpen(false);
                    setModelMenuOpen(false);
                    setWorkspaceEditing(false);
                    setSessionMenuId(null);
                    setPermissionOpen(next);
                  }}
                >
                  <I name={s.permissionMode === "danger-full-access" ? "fullAccess" : s.permissionMode === "read-only" ? "readOnly" : "workspaceWrite"} />
                  <span>
                    {s.permissionMode === "danger-full-access"
                      ? t.fullMode
                      : s.permissionMode === "read-only"
                        ? t.askMode
                        : t.reviewMode}
                  </span>
                  <I name="down" />
                </button>
                {permissionOpen && (
                  <div className="permission-menu">
                    {(
                      [
                        ["read-only", t.askMode, t.askHelp, "readOnly"],
                        ["workspace-write", t.reviewMode, t.reviewHelp, "workspaceWrite"],
                        ["danger-full-access", t.fullMode, t.fullHelp, "fullAccess"],
                      ] as const
                    ).map(([value, label, help, icon]) => (
                      <button
                        className={`${s.permissionMode === value ? "selected" : ""} ${value === "danger-full-access" ? "danger" : ""}`}
                        key={value}
                        onClick={() => void choosePermission(value)}
                      >
                        <I name={icon} />
                        <span>
                          <b>{label}</b>
                          <small>{help}</small>
                        </span>
                        {s.permissionMode === value && <i>✓</i>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className={"adhd-toggle" + (adhdActive ? " on" : "")}
                aria-pressed={adhdActive}
                title={lang === "zh" ? "为当前会话注入 ADHD 输出风格（自下次发送起生效）" : "Inject the ADHD output style for this session (applies from the next send)"}
                onClick={toggleAdhd}
              >
                <I name="bolt" />
                <span>ADHD</span>
              </button>
              <span />
              <div className="model-control">
                <button className="composer-select model-select" onClick={() => {
                  const next = !modelMenuOpen;
                  setCommandOpen(false);
                  setPermissionOpen(false);
                  setWorkspaceEditing(false);
                  setSessionMenuId(null);
                  setModelMenuOpen(next);
                }}><span>{selectedModel?.name || (configured ? s.model : t.models)}</span><I name="down" /></button>
                {modelMenuOpen && <div className="model-menu">{modelProviders.length ? modelProviders.map((item) => <section key={item.id}><header><b>{item.name}</b><small>{credentialIds.has(item.id) ? t.configured : t.unconfigured}</small></header>{item.models.map((model) => <button className={selectedProviderId === item.id && s.model === model.id ? "selected" : ""} key={model.id} onClick={() => { setSelectedProviderId(item.id); setS({ ...s, baseUrl: item.baseUrl, protocol: item.protocol, model: model.id, contextBudget: model.contextBudget ?? 120000, reasoningEffort: "" }); setModelMenuOpen(false); }}><span><b>{model.name || model.id}</b><small>{model.id}</small></span>{selectedProviderId === item.id && s.model === model.id && <i>✓</i>}</button>)}</section>) : <button onClick={() => { setModelMenuOpen(false); openSettings(); }}>{lang === "zh" ? "添加模型提供商" : "Add a model provider"}</button>}</div>}
              </div>
              {run && <div className="context-control">
                <button className="context-ring" aria-expanded={contextOpen} aria-label={`${lang === "zh" ? "查看上下文用量" : "View context usage"} ${contextPercent}%`} onClick={() => { setContextOpen(!contextOpen); setPermissionOpen(false); setModelMenuOpen(false); }} style={{ "--context": `${contextPercent * 3.6}deg` } as React.CSSProperties}><i /></button>
                {contextOpen && <div className="context-popover">
                  <header><b>{lang === "zh" ? "上下文已用" : "Context used"} {contextPercent}%</b><span>~{formatTokens(currentContextTokens)} / {formatTokens(Number(run.task.modelProfile.contextBudget ?? s.contextBudget))}</span></header>
                  <div className="context-meter"><i style={{ width: `${contextPercent}%` }} /></div>
                  <ul>
                    <li><i className="system" /><span>{lang === "zh" ? "系统提示词" : "System prompt"}</span><b>~{formatTokens(contextBreakdown.system)}</b></li>
                    <li><i className="tools" /><span>{lang === "zh" ? "工具" : "Tools"}</span><b>~{formatTokens(contextBreakdown.tools)}</b></li>
                    <li><i className="dialog" /><span>{lang === "zh" ? "对话消息" : "Conversation"}</span><b>~{formatTokens(contextBreakdown.dialog)}</b></li>
                  </ul>
                  <small>{lang === "zh" ? "分类为基于实际请求内容的近似 token；总量优先采用模型 usage，不完整时以请求估算兜底。" : "Categories are estimated from the actual request; total prefers model usage and falls back to the request estimate."}</small>
                </div>}
              </div>}
              <button
                className={"send " + (active || sending ? "active" : "")}
                disabled={sending && !active}
                aria-label={active ? (lang === "zh" ? "停止运行" : "Stop run") : (lang === "zh" ? "发送" : "Send")}
                onClick={
                  active
                    ? () =>
                        fetch(`/api/runs/${run!.id}/cancel`, { method: "POST" })
                    : () => void submitPrompt()
                }
              >
                <I name={active ? "stop" : "send"} />
              </button>
            </footer>
          </div>
          {run && <div className="run-stats"><span>{turnCount} {lang === "zh" ? "轮" : "turns"} · {toolCount} {lang === "zh" ? "步" : "steps"}</span><i /><span>LLM {formatDuration(performance.llmMs)} · {lang === "zh" ? "工具调用" : "tools"} {formatDuration(performance.toolMs)}</span><i /><span>{lang === "zh" ? "首 token 平均" : "avg first token"} {formatDuration(performance.averageFirstTokenMs)} · {performance.tokensPerSecond.toFixed(1)} tok/s</span><i /><span>{lang === "zh" ? "缓存命中" : "cache hit"} {cachePercent}%</span><i /><span>{lang === "zh" ? "输入" : "in"} {usage.inputTokens.toLocaleString()} tok · {lang === "zh" ? "输出" : "out"} {usage.outputTokens.toLocaleString()} tok</span></div>}
          <small className="disclaimer">{t.mistakes}</small>
        </div>
      </main>
      {details && (
        <aside className="details">
          <header>
            <strong>{t.details}</strong>
            <button onClick={() => setDetails(false)}>×</button>
          </header>
          {selected ? (
            <div className="event-inspector">
              <div className="details-tabs"><button className={detailsTab === "summary" ? "active" : ""} onClick={() => setDetailsTab("summary")}>{lang === "zh" ? "摘要" : "Summary"}</button><button className={detailsTab === "raw" ? "active" : ""} onClick={() => setDetailsTab("raw")}>{lang === "zh" ? "原始数据" : "Raw"}</button><button className={detailsTab === "source" ? "active" : ""} onClick={() => setDetailsTab("source")}>{lang === "zh" ? "来源" : "Source"}</button></div>
              {detailsTab === "summary" ? <div className="event-summary"><dl>
                <dt>{lang === "zh" ? "事件" : "Event"}</dt><dd>{eventDisplayName(selected.type, lang)}</dd>
                <dt>{lang === "zh" ? "状态" : "Status"}</dt><dd>{selected.type.endsWith("failed") ? (lang === "zh" ? "失败" : "Failed") : (lang === "zh" ? "已完成" : "Completed")}</dd>
                <dt>{lang === "zh" ? "时间" : "Time"}</dt><dd>{new Date(selected.at).toLocaleString()}</dd>
                {selectedInspection?.durationMs !== undefined && <><dt>{lang === "zh" ? "关联耗时" : "Related duration"}</dt><dd>{formatDuration(selectedInspection.durationMs)}</dd></>}
                {selected.data.usage?.inputTokens !== undefined && <><dt>{lang === "zh" ? "输入 token" : "Input tokens"}</dt><dd>{Number(selected.data.usage.inputTokens).toLocaleString()}</dd></>}
                {selected.data.usage?.outputTokens !== undefined && <><dt>{lang === "zh" ? "输出 token" : "Output tokens"}</dt><dd>{Number(selected.data.usage.outputTokens).toLocaleString()}</dd></>}
                {selected.data.usage?.cachedInputTokens !== undefined && <><dt>{lang === "zh" ? "缓存 token" : "Cached tokens"}</dt><dd>{Number(selected.data.usage.cachedInputTokens).toLocaleString()}</dd></>}
              </dl><b>{lang === "zh" ? "预览" : "Preview"}</b><pre>{String(selected.data.content ?? selected.data.reasoning ?? selected.data.input ?? selected.data.output ?? selected.data.error ?? JSON.stringify(selected.data, null, 2))}</pre></div> : detailsTab === "raw" ? <pre>{JSON.stringify(selected.data, null, 2)}</pre> : <div className="event-source">
                <b>{selectedInspection?.component === "tool" ? (lang === "zh" ? "工具执行层" : "Tool execution layer") : selectedInspection?.component === "model" ? (lang === "zh" ? "模型适配器" : "Model adapter") : (lang === "zh" ? "Harness 运行核心" : "Harness runtime core")}</b>
                <dl>
                  <dt>{lang === "zh" ? "运行 ID" : "Run ID"}</dt><dd>{selected.runId ?? run?.id}</dd>
                  <dt>{lang === "zh" ? "事件序号" : "Event sequence"}</dt><dd>#{selected.seq}</dd>
                  <dt>{lang === "zh" ? "事件类型" : "Event type"}</dt><dd>{selected.type}</dd>
                  <dt>{lang === "zh" ? "持久化" : "Persistence"}</dt><dd>SQLite events + runs/{selected.runId ?? run?.id}.jsonl</dd>
                  {selectedInspection?.related && <><dt>{lang === "zh" ? "关联事件" : "Related event"}</dt><dd>#{selectedInspection.related.seq} · {eventDisplayName(selectedInspection.related.type, lang)}</dd></>}
                  {(selected.data.id || selected.data.toolCallId) && <><dt>{lang === "zh" ? "关联 ID" : "Correlation ID"}</dt><dd>{String(selected.data.id ?? selected.data.toolCallId)}</dd></>}
                  {selected.data.turn !== undefined && <><dt>{lang === "zh" ? "模型轮次" : "Model turn"}</dt><dd>{Number(selected.data.turn) + 1}</dd></>}
                </dl>
                <p>{lang === "zh" ? "以上字段直接来自当前运行的追加式轨迹和事件关联，不是展示用模拟数据。" : "These fields come directly from the append-only trace and event correlations; they are not display fixtures."}</p>
              </div>}
            </div>
          ) : (
            <p>{t.inspect}</p>
          )}
          {run && <a href={`/api/runs/${run.id}/export`}>{t.export}</a>}
        </aside>
      )}
      {projectDialog && (
        <div
          className="backdrop project-backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && !projectPicking && setProjectDialog(false)}
        >
          <section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
            <header>
              <h2 id="project-dialog-title">{lang === "zh" ? "创建项目" : "Create project"}</h2>
              <button aria-label={t.close} disabled={projectPicking} onClick={() => setProjectDialog(false)}>×</button>
            </header>
            <div className="project-content">
              <label className="project-name-field">
                <span>{lang === "zh" ? "项目名称" : "Project name"}</span>
                <div><I name="folder" /><input autoFocus value={projectName} placeholder={lang === "zh" ? "输入项目名称" : "Enter project name"} onChange={(e) => setProjectName(e.target.value)} /></div>
              </label>
              <div className="project-source-field">
                <span>{lang === "zh" ? "来源文件夹" : "Source folder"}</span>
                <button className={projectPath ? "selected" : ""} disabled={projectPicking} onClick={() => void chooseProjectFolder()}>
                  <I name={projectPath ? "folder" : "folderPlus"} />
                  <span>
                    <b>{projectPicking ? (lang === "zh" ? "正在打开资源管理器…" : "Opening File Explorer…") : projectPath ? projectPath.split(/[\\/]/).filter(Boolean).at(-1) : (lang === "zh" ? "选择项目文件夹" : "Choose project folder")}</b>
                    <small>{projectPath || (lang === "zh" ? "选择 TCode 可读取和编辑的文件夹" : "Choose a folder TCode can read and edit")}</small>
                  </span>
                </button>
              </div>
              {error && <div className="project-error">{error}</div>}
            </div>
            <footer>
              <button disabled={projectPicking} onClick={() => setProjectDialog(false)}>{lang === "zh" ? "取消" : "Cancel"}</button>
              <button className="primary" disabled={projectPicking || !projectName.trim() || !projectPath} onClick={() => void createProject()}>{lang === "zh" ? "创建项目" : "Create project"}</button>
            </footer>
          </section>
        </div>
      )}
      {modal && (
        <div
          className="backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && setModal(false)}
        >
          <section className="settings-modal">
            <aside>
              <div className="settings-heading">
                <b>{t.settings}</b>
                <button onClick={() => setModal(false)}>×</button>
              </div>
              <nav>
                <button
                  className={section === "general" ? "selected" : ""}
                  onClick={() => setSection("general")}
                >
                  <I name="sliders" />
                  {t.general}
                </button>
                <button
                  className={section === "models" ? "selected" : ""}
                  onClick={() => setSection("models")}
                >
                  <I name="spark" />
                  {t.models}
                </button>
                <button
                  className={section === "prompt" ? "selected" : ""}
                  onClick={() => { setSection("prompt"); void loadSystemPrompt(); }}
                >
                  <I name="document" />
                  {lang === "zh" ? "提示词" : "Prompt"}
                </button>
              </nav>
              <small>TCode 0.1.0</small>
            </aside>
            <div className="settings-main">
              <header className="settings-top-actions">
                <button className="settings-close" onClick={() => setModal(false)} aria-label={t.close}>×</button>
              </header>
            <div className="settings-content" key={section}>
              {section === "general" && (
                <>
                  <header>
                    <h2>{t.general}</h2>
                  </header>
                  <section className="setting-group">
                     <label>
                       <span>
                         <b>{t.language}</b>
                         <small>{t.languageHelp}</small>
                      </span>
                      <div className="language-control">
                        <button onClick={() => { setLanguageMenuOpen(!languageMenuOpen); setEnterMenuOpen(false); }}>{lang === "zh" ? "简体中文" : "English"}<I name="down" /></button>
                        {languageMenuOpen && <div className="language-menu">{(["zh", "en"] as const).map((value) => <button className={lang === value ? "selected" : ""} key={value} onClick={() => { setLang(value); setLanguageMenuOpen(false); }}>{value === "zh" ? "简体中文" : "English"}{lang === value && <i>✓</i>}</button>)}</div>}
                      </div>
                     </label>
                     <label>
                       <span>
                         <b>{lang === "zh" ? "智能体运行时 Enter 键行为" : "Enter while the agent is running"}</b>
                         <small>{lang === "zh" ? "Ctrl/Cmd + Enter 使用另一发送方式" : "Ctrl/Cmd + Enter uses the other send behavior"}</small>
                       </span>
                       <div className="enter-behavior-control">
                         <button onClick={() => setEnterMenuOpen(!enterMenuOpen)}>{enterBehavior === "queue" ? (lang === "zh" ? "排队发送" : "Queue message") : (lang === "zh" ? "插话发送" : "Steer immediately")}<I name="down" /></button>
                         {enterMenuOpen && <div className="enter-behavior-menu">{(["queue", "steer"] as const).map((mode) => <button key={mode} className={enterBehavior === mode ? "selected" : ""} onClick={() => { setEnterBehavior(mode); setEnterMenuOpen(false); }}><span><b>{mode === "queue" ? (lang === "zh" ? "排队发送" : "Queue message") : (lang === "zh" ? "插话发送" : "Steer immediately")}</b><small>{mode === "queue" ? (lang === "zh" ? "当前任务完成后处理" : "Process after the current task") : (lang === "zh" ? "在下一轮模型调用前插入" : "Inject before the next model turn")}</small></span>{enterBehavior === mode && <i>✓</i>}</button>)}</div>}
                       </div>
                     </label>
                   </section>
                  <section className={`archived-sessions${archivedOpen ? " open" : ""}`}>
                    <header>
                      <button className="archive-toggle" onClick={() => setArchivedOpen(!archivedOpen)}><span><b>{lang === "zh" ? "已归档会话" : "Archived sessions"}</b><small>{archivedSessions.length} {lang === "zh" ? "个会话" : "sessions"}</small></span><I name="down" /></button>
                      {archivedOpen && archivedSessions.length > 0 && <div className="archive-actions">
                        <button onClick={() => setArchivedSelected(archivedSelected.size === archivedSessions.length ? new Set() : new Set(archivedSessions.map((session) => session.id)))}>{archivedSelected.size === archivedSessions.length ? (lang === "zh" ? "取消全选" : "Clear") : (lang === "zh" ? "全选" : "Select all")}</button>
                        <button className="danger" disabled={!archivedSelected.size} onClick={() => void deleteArchived([...archivedSelected])}><I name="trash" />{lang === "zh" ? `永久删除${archivedSelected.size ? ` (${archivedSelected.size})` : ""}` : `Delete${archivedSelected.size ? ` (${archivedSelected.size})` : ""}`}</button>
                      </div>}
                    </header>
                    {archivedOpen && <div className="archived-body">{archivedSessions.length ? archivedSessions.map((session) => <div className="archived-row" key={session.id}><button className={`archive-check${archivedSelected.has(session.id) ? " selected" : ""}`} aria-label={lang === "zh" ? "选择会话" : "Select session"} onClick={() => toggleSet(setArchivedSelected, session.id)}>{archivedSelected.has(session.id) && <I name="check" />}</button><span><b>{session.title}</b><small>{workspaces.find((workspace) => workspace.path === session.workspacePath)?.title ?? session.workspacePath}</small></span><button className="restore" onClick={() => void restoreSession(session.id)}>{lang === "zh" ? "恢复" : "Restore"}</button></div>) : <p>{lang === "zh" ? "暂无已归档会话" : "No archived sessions"}</p>}</div>}
                  </section>
                </>
              )}
              {section === "prompt" && (
                <>
                  <header>
                    <h2>{lang === "zh" ? "系统提示词" : "System prompt"}</h2>
                    <p>{lang === "zh" ? "对所有权限模式生效；保存后新会话立即使用。" : "Applies to every permission mode; new sessions pick it up immediately."}</p>
                  </header>
                  <section className="prompt-editor">
                    <div className="prompt-toolbar">
                      <em className={systemPromptBase?.custom ? "custom" : ""}>{systemPromptBase?.custom ? (lang === "zh" ? "已自定义" : "Custom") : (lang === "zh" ? "默认" : "Default")}</em>
                      <small>{systemPromptDraft.length.toLocaleString()} / 20,000</small>
                    </div>
                    <textarea
                      className="prompt-textarea"
                      value={systemPromptDraft}
                      spellCheck={false}
                      disabled={!systemPromptBase || systemPromptBusy}
                      onChange={(e) => setSystemPromptDraft(e.target.value)}
                    />
                    <footer className="prompt-actions">
                      <button
                        className="primary"
                        disabled={systemPromptBusy || !systemPromptBase || !systemPromptDraft.trim() || systemPromptDraft === (systemPromptBase.custom ?? systemPromptBase.default)}
                        onClick={() => void saveSystemPrompt()}
                      >
                        {systemPromptBusy ? (lang === "zh" ? "保存中…" : "Saving…") : (lang === "zh" ? "保存" : "Save")}
                      </button>
                      <button
                        disabled={systemPromptBusy || (!systemPromptBase?.custom && systemPromptDraft === systemPromptBase?.default)}
                        onClick={() => void resetSystemPrompt()}
                      >
                        {lang === "zh" ? "恢复默认" : "Reset to default"}
                      </button>
                      <button
                        className="adhd-inject"
                        disabled={systemPromptBusy || !systemPromptBase || systemPromptDraft.includes("# i-have-adhd")}
                        onClick={() => void injectAdhdSkill()}
                      >
                        <I name="bolt" />
                        {systemPromptDraft.includes("# i-have-adhd") ? (lang === "zh" ? "ADHD 已注入" : "ADHD injected") : (lang === "zh" ? "注入 ADHD skill" : "Inject ADHD skill")}
                      </button>
                      {systemPromptSavedAt > 0 && systemPromptDraft === (systemPromptBase?.custom ?? systemPromptBase?.default) && (
                        <span className="prompt-ok"><I name="check" />{lang === "zh" ? "已保存" : "Saved"}</span>
                      )}
                    </footer>
                    <small className="prompt-note">{lang === "zh" ? "默认提示词内含工程守则（八荣八耻与核心原则）；可在此基础上修改或完全替换。" : "The default prompt ships with the engineering conduct rules; edit or replace it freely."}</small>
                  </section>
                </>
              )}
              {section === "models" && (
                <>
                  <header>
                    <h2>{t.models}</h2>
                    <p>{lang === "zh" ? "管理 OpenAI-compatible 提供商及其模型。" : "Manage OpenAI-compatible providers and their models."}</p>
                  </header>
                  {notice && <div className="notice">✓ {notice}</div>}
                  <div className="provider-list">
                    {modelProviders.map((item) => <section className="provider-row" key={item.id}><span className="provider-mark">{item.name.slice(0, 1).toUpperCase()}</span><span><b>{item.name}</b><small>{item.models.length} {lang === "zh" ? "个模型" : "models"} · {new URL(item.baseUrl).host}</small></span><em className={credentialIds.has(item.id) ? "ready" : "missing"}>{credentialIds.has(item.id) ? t.configured : t.unconfigured}</em><button onClick={() => editProvider(item)}>{t.edit}</button></section>)}
                  </div>
                  {editingProviderId && providerDraft && <div className="provider-editor-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) { setEditingProviderId(null); setProviderDraft(null); } }}><section className="provider-editor provider-editor-card" role="dialog" aria-modal="true" aria-label={editingProviderId === "__new__" ? (lang === "zh" ? "自定义提供方" : "Custom provider") : providerDraft.name} onMouseDown={(e) => e.stopPropagation()}>
                    <header><b>{editingProviderId === "__new__" ? (lang === "zh" ? "自定义提供方" : "Custom provider") : providerDraft.name}</b></header>
                    <div className="provider-fields">
                      <label><span>Provider ID</span><input disabled={editingProviderId !== "__new__"} value={providerDraft.id} placeholder="acme-gateway" onChange={(e) => setProviderDraft({ ...providerDraft, id: e.target.value })} /><small>{lang === "zh" ? "使用小写字母、数字、点、下划线或连字符，用于唯一标识该提供方。" : "Use lowercase letters, numbers, dots, underscores, or hyphens to identify this provider."}</small></label>
                      <label><span>{lang === "zh" ? "显示名称" : "Display name"}</span><input value={providerDraft.name} placeholder={lang === "zh" ? "显示名称" : "Display name"} onChange={(e) => setProviderDraft({ ...providerDraft, name: e.target.value })} /></label>
                      <label><span>{lang === "zh" ? "API 地址" : "API URL"}</span><input value={providerDraft.baseUrl} placeholder="https://gateway.example/v1" onChange={(e) => setProviderDraft({ ...providerDraft, baseUrl: e.target.value })} /></label>
                      <label className="protocol-field"><span>{lang === "zh" ? "API 协议" : "API protocol"}</span><div className="protocol-options"><button type="button" className={providerDraft.protocol === "chat-completions" ? "selected" : ""} onClick={() => setProviderDraft({ ...providerDraft, protocol: "chat-completions" })}>Chat Completions</button><button type="button" className={providerDraft.protocol === "responses" ? "selected" : ""} onClick={() => setProviderDraft({ ...providerDraft, protocol: "responses" })}>Responses</button></div></label>
                      <label><span>{lang === "zh" ? "API 密钥" : "API key"}</span><input type="password" autoComplete="new-password" value={key} placeholder={credentialIds.has(providerDraft.id) ? "••••••••••••••••" : (lang === "zh" ? "输入 API 密钥" : "Enter API key")} onChange={(e) => setKey(e.target.value)} /></label>
                    </div>
                    <div className="model-directory"><header><b>{lang === "zh" ? "模型目录" : "Model directory"}</b><button disabled={discoveringModels || !providerDraft.baseUrl.trim() || (!key && (editingProviderId === "__new__" || !credentialIds.has(providerDraft.id)))} onClick={() => void discoverProviderModels()}>{discoveringModels ? (lang === "zh" ? "正在获取…" : "Fetching…") : (lang === "zh" ? "获取可用模型" : "Fetch available models")}</button></header>{providerDraft.models.length === 0 && <div className="model-empty">{lang === "zh" ? "尚未获取模型。也可以手动添加模型 ID。" : "No models loaded. You can also add a model ID manually."}</div>}{providerDraft.models.map((model, index) => <div className="model-row" key={index}><input aria-label={lang === "zh" ? "模型 ID" : "Model ID"} placeholder={lang === "zh" ? "模型 ID" : "Model ID"} value={model.id} onChange={(e) => setProviderDraft({ ...providerDraft, models: providerDraft.models.map((item, i) => i === index ? { ...item, id: e.target.value } : item) })} /><input aria-label={lang === "zh" ? "显示名称" : "Display name"} placeholder={lang === "zh" ? "显示名称（可选）" : "Display name (optional)"} value={model.name ?? ""} onChange={(e) => setProviderDraft({ ...providerDraft, models: providerDraft.models.map((item, i) => i === index ? { ...item, name: e.target.value } : item) })} /><button aria-label={lang === "zh" ? "删除模型" : "Remove model"} onClick={() => setProviderDraft({ ...providerDraft, models: providerDraft.models.filter((_, i) => i !== index) })}><I name="trash" /></button></div>)}<button className="add-model" onClick={() => setProviderDraft({ ...providerDraft, models: [...providerDraft.models, { id: "", name: "" }] })}>{lang === "zh" ? "添加模型" : "Add model"}</button></div>
                    {error && <div className="inline-error">{error}</div>}
                    <footer>{editingProviderId !== "__new__" && <button className="danger" onClick={() => void removeProvider(providerDraft.id)}>{lang === "zh" ? "删除提供方" : "Delete provider"}</button>}<span /><button onClick={() => { setEditingProviderId(null); setProviderDraft(null); }}>{lang === "zh" ? "取消" : "Cancel"}</button><button className="primary" disabled={!providerDraft.id.trim() || !providerDraft.name.trim() || !providerDraft.baseUrl.trim() || !providerDraft.models.some((model) => model.id.trim()) || (editingProviderId === "__new__" && !key.trim())} onClick={() => void saveProvider()}>{editingProviderId === "__new__" ? (lang === "zh" ? "创建提供方" : "Create provider") : t.save}</button></footer>
                  </section></div>}
                  <div className="add-provider"><button onClick={beginProvider}><I name="plus" />{lang === "zh" ? "添加提供商" : "Add provider"}</button></div>
                </>
              )}
            </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);



