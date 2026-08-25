import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Message, RunRecord, TaskDefinition, ToolCall, TraceEvent } from "./types.js";
type ConversationMessage = Pick<Message, "role" | "content" | "toolCallId" | "name" | "toolCalls">;
import { SYSTEM_PROMPT, TOOL_DEFINITIONS } from "./system-prompt.js";
import { ADHD_SKILL } from "./adhd-skill.js";
import { OpenAICompatibleModel } from "./model.js";
import { PersistentPowerShell } from "./shell.js";
import { strReplaceEditor } from "./editor.js";
import { resolvePermissionPolicy, escapesWorkspace } from "./permissions.js";
import { SandboxUnavailableError } from "./shell.js";
import { TraceStore } from "./trace.js";

export interface ApprovalRequest {
  id: string;
  runId: string;
  tool: string;
  input: string;
  reasons: string[];
  /** Boundary-crossing write: the UI must render this red with an extra warning. */
  danger?: boolean;
  approvalKey?: string;
  createdAt: string;
}
type ApprovalResolver = (allow: boolean) => void;

// Every executed tool result carries its wall-clock cost as a trailing
// marker, mirroring the `[exit code: N]` convention.
function appendTiming(content: string, startedAt: number): string {
  const marker = `[time: ${((Date.now() - startedAt) / 1000).toFixed(2)}s]`;
  return content.length === 0 ? marker : `${content}\n${marker}`;
}

export class ApprovalQueue {
  private pending = new Map<
    string,
    { request: ApprovalRequest; resolve: ApprovalResolver }
  >();
  private allowed = new Set<string>();
  constructor(
    private store?: TraceStore,
    private onChange?: (
      request: ApprovalRequest,
      state: "pending" | "resolved",
      allow?: boolean,
    ) => void,
  ) {
    try {
      const saved = JSON.parse(this.store?.getSetting("approvalRules") ?? "[]");
      if (Array.isArray(saved)) this.allowed = new Set(saved.filter((x): x is string => typeof x === "string"));
    } catch {}
  }
  isAllowed(key: string | undefined) { return Boolean(key && this.allowed.has(key)); }
  request(runId: string, tool: string, input: string, reasons: string[], danger = false, approvalKey?: string) {
    const request: ApprovalRequest = {
      id: randomUUID(),
      runId,
      tool,
      input,
      reasons,
      ...(danger ? { danger: true } : {}),
      ...(approvalKey ? { approvalKey } : {}),
      createdAt: new Date().toISOString(),
    };
    return new Promise<boolean>((resolve) => {
      this.pending.set(request.id, { request, resolve });
      this.onChange?.(request, "pending");
    });
  }
  list(runId?: string) {
    return [...this.pending.values()]
      .map((x) => x.request)
      .filter((x) => !runId || x.runId === runId);
  }
  resolve(id: string, allow: boolean, remember = false) {
    const item = this.pending.get(id);
    if (!item) return false;
    this.pending.delete(id);
    if (allow && remember && item.request.approvalKey && !item.request.danger) {
      this.allowed.add(item.request.approvalKey);
      this.store?.setSetting("approvalRules", JSON.stringify([...this.allowed].sort()));
    }
    item.resolve(allow);
    this.onChange?.(item.request, "resolved", allow);
    return true;
  }
  cancelRun(runId: string) {
    for (const [id, item] of this.pending)
      if (item.request.runId === runId) {
        this.pending.delete(id);
        item.resolve(false);
      }
  }
}

const PWSH_APPROVAL_KEY = "pwsh:command";

function conversationMessage(event: TraceEvent): ConversationMessage | undefined {
  if (event.type === "user_message") return { role: "user", content: String(event.data.content ?? "") };
  if (event.type === "model_response") {
    return {
      role: "assistant",
      content: String(event.data.content ?? ""),
      toolCalls: Array.isArray(event.data.toolCalls) ? event.data.toolCalls : [],
    };
  }
  if (event.type === "tool_result")
    return {
      role: "tool",
      content: String(event.data.output ?? ""),
      name: event.data.name === "pwsh" || event.data.name === "str_replace_editor" ? event.data.name : undefined,
      toolCallId: typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined,
    };
  return undefined;
}

export class HarnessRun {
  readonly id: string;
  private aborter = new AbortController();
  private shell: PersistentPowerShell;
  private hostShell: PersistentPowerShell;
  private model: OpenAICompatibleModel;
  private messages: Message[];
  private started = Date.now();
  private steeredMessages: string[] = [];
  private queuedMessages: string[] = [];
  private acceptingMessages = true;
  private boundaryWarned = new Set<string>();
  private pendingBoundaryWarnings: string[] = [];
  private readonly systemPrompt: string;

  constructor(
    readonly task: TaskDefinition,
    apiKey: string,
    private store: TraceStore,
    private approvals: ApprovalQueue,
    id = randomUUID(),
    systemPrompt: string = SYSTEM_PROMPT,
  ) {
    this.id = id;
    this.systemPrompt = systemPrompt;
    const policy = resolvePermissionPolicy(task.permissionMode);
    this.messages = this.createInitialMessages();
    // Both the model-facing pwsh tool and the host (setup/grader) shell use
    // PersistentPowerShell over node-pty/ConPTY, matching the DSH minimal
    // preset's win32 stack. The model-facing shell keeps the 16k budget of
    // the DSH minimal pwsh tool; the host shell keeps a larger diagnostic budget.
    this.shell = new PersistentPowerShell(task.workspace, 16_000, policy.sandboxMode);
    this.hostShell = new PersistentPowerShell(task.workspace, 200_000, policy.sandboxMode);
    this.model = new OpenAICompatibleModel(task.modelProfile, apiKey);
  }

  private createInitialMessages(): Message[] {
    const messages: Message[] = [
      { role: "system", content: this.systemPrompt },
    ];
    if (!this.task.sessionId) {
      messages.push({ role: "user", content: this.task.prompt });
      return messages;
    }
    for (const run of this.store.listRuns({ sessionId: this.task.sessionId })) {
      for (const event of this.store.events(run.id)) {
        const message = conversationMessage(event);
        if (message) messages.push(message);
      }
    }
    messages.push({ role: "user", content: this.task.prompt });
    return messages;
  }

  cancel() {
    this.acceptingMessages = false;
    this.aborter.abort();
    this.approvals.cancelRun(this.id);
  }

  enqueueMessage(content: string, mode: "queue" | "steer") {
    const value = content.trim();
    if (!this.acceptingMessages || !value) return false;
    (mode === "steer" ? this.steeredMessages : this.queuedMessages).push(value);
    void this.trace("user_message_queued", { content: value, mode });
    return true;
  }

  private async injectNextUserMessage(includeQueued: boolean) {
    const mode = this.steeredMessages.length ? "steer" : includeQueued && this.queuedMessages.length ? "queue" : undefined;
    if (!mode) return false;
    const content = (mode === "steer" ? this.steeredMessages : this.queuedMessages).shift()!;
    this.messages.push({ role: "user", content });
    await this.trace("user_message", { content, mode });
    return true;
  }

  private async trace(type: string, data: Record<string, unknown>) {
    return this.store.append(this.id, type, data);
  }

  // Full access may cross the workspace boundary; each distinct crossing
  // injects a warning telling the model to get the user's verbal consent.
  // It adds no approval prompts and never blocks.
  private noteBoundaryEscape(path: string) {
    if (this.boundaryWarned.has(path)) return;
    this.boundaryWarned.add(path);
    this.pendingBoundaryWarnings.push(path);
  }

  private async flushBoundaryWarnings() {
    while (this.pendingBoundaryWarnings.length) {
      const path = this.pendingBoundaryWarnings.shift()!;
      const warning =
        `[harness] 检测到对工作区之外路径的访问：${path}。非必要严禁越界操作！继续越界前请先口头征得用户同意。\n` +
        `Out-of-workspace access detected: ${path}. Crossing the workspace boundary is strictly forbidden unless necessary — get the user's explicit consent first.`;
      this.messages.push({ role: "user", content: warning });
      await this.trace("boundary_warning", { path, message: warning });
    }
  }

  private async ask(call: ToolCall, reasons: string[], danger = false, approvalKey?: string) {
    if (!danger && this.approvals.isAllowed(approvalKey)) {
      await this.trace("approval_rule_applied", { toolCallId: call.id, approvalKey });
      return true;
    }
    this.store.updateRun(this.id, "waiting_approval");
    await this.trace("approval_requested", {
      toolCallId: call.id,
      tool: call.name,
      input: call.input,
      reasons,
      ...(danger ? { danger: true } : {}),
      ...(approvalKey ? { approvalKey } : {}),
    });
    const allow = await this.approvals.request(
      this.id,
      call.name,
      JSON.stringify(call.input),
      reasons,
      danger,
      approvalKey,
    );
    await this.trace("approval_resolved", { toolCallId: call.id, allow });
    this.store.updateRun(this.id, "running");
    return allow;
  }

  private async execute(call: ToolCall) {
    if (!["pwsh", "str_replace_editor"].includes(call.name))
      throw new Error(`Unknown tool: ${call.name}`);
    const policy = resolvePermissionPolicy(this.task.permissionMode);
    if (call.name === "str_replace_editor") {
      const command = String(call.input.command ?? "");
      const writes = command !== "view";
      if (writes && policy.sandboxMode === "read-only")
        return "Denied by execution policy or user approval.";
      const path = typeof call.input.path === "string" ? call.input.path : undefined;
      let boundaryApproved = false;
      if (
        path !== undefined
        && isAbsolute(path)
        && policy.sandboxMode !== "read-only"
        && await escapesWorkspace(this.task.workspace, path)
      ) {
        // Full access may cross with a per-path warning only. In
        // workspace-write, out-of-workspace writes warn the model and need a
        // per-call user approval (approve covers exactly this one write);
        // out-of-workspace reads are rejected outright.
        if (policy.sandboxMode === "danger-full-access") {
          this.noteBoundaryEscape(path);
        } else if (writes) {
          this.noteBoundaryEscape(path);
          boundaryApproved = await this.ask(call, [
            "Out-of-workspace write",
            `${path} is outside the workspace`,
            "Approval covers only this single write",
          ], true);
          if (!boundaryApproved)
            return `Denied: the user rejected this out-of-workspace write to ${path}.`;
        } else {
          return `Denied: ${path} is outside the workspace; workspace-write mode only permits operations inside the workspace.`;
        }
      }
      // A boundary approval already covers the write itself; normal writes
      // still go through the regular per-call approval.
      if (
        writes
        && !boundaryApproved
        && policy.approvalPolicy === "ask"
        && !(await this.ask(call, [`str_replace_editor ${command} modifies the filesystem`], false, `editor:${command}`))
      )
        return "Denied by execution policy or user approval.";
      const editorStarted = Date.now();
      return appendTiming(await strReplaceEditor(call.input, policy.sandboxMode), editorStarted);
    }
    // DSH sandbox modes govern file effects, not networking. Until a real
    // network backend exists, network-disabled tasks fail closed for shell.
    if (!this.task.network) return "Denied by execution policy or user approval.";
    // DSH minimal has no per-command classifier: read-only mode lets the
    // sandbox deny writes (detected post-hoc from stderr), workspace-write
    // asks approval for every command, and danger-full-access runs free.
    if (
      policy.sandboxMode === "workspace-write"
      && policy.approvalPolicy === "ask"
      && !(await this.ask(call, [`pwsh may modify the workspace under workspace-write sandboxing`], false, PWSH_APPROVAL_KEY))
    )
      return "Denied by execution policy or user approval.";
    const shellStarted = Date.now();
    const result = await this.shell.execute(
      String(call.input.command),
      this.task.toolTimeout,
      this.aborter.signal,
    );
    // Surface sandbox denials detected from the confined stderr so the model
    // sees a file-access-denied marker rather than a bare failed command.
    // Match both English ("access is denied", "permission denied") and the
    // localized zh-CN message ("访问被拒绝") — Windows PowerShell 5.1 emits
    // errors in the system locale, so an English-only regex would miss denials
    // on non-English Windows.
    const denied = /\b(access is denied|access to the path|permission denied)\b/i.test(result.output)
      || /访问被拒绝/.test(result.output);
    if (denied && policy.sandboxMode !== "danger-full-access") {
      return appendTiming(`${result.output}\n[sandbox: file access denied under ${policy.sandboxMode} mode]`, shellStarted);
    }
    return appendTiming(result.output, shellStarted);
  }

  async run() {
    let failed = false;
    let primary: unknown;
    try {
      await stat(this.task.workspace);
    this.store.updateRun(this.id, "running");
    await this.trace("run_started", {
      task: this.task,
      permissionPolicy: resolvePermissionPolicy(this.task.permissionMode),
      systemPrompt: this.systemPrompt,
      tools: TOOL_DEFINITIONS,
      harnessVersion: "0.1.0",
      platform: process.platform,
    });
    // Trace the initial prompt as a user_message so the event stream is
    // self-contained: the chat view and future session runs can reconstruct
    // the full conversation from events alone, without run.task.prompt.
    await this.trace("user_message", { content: this.task.prompt, mode: "initial" });
      for (const command of this.task.setup) {
        const result = await this.hostShell.execute(
          command,
          this.task.toolTimeout,
          this.aborter.signal,
        );
        await this.trace("setup", { command, result });
        if (result.exitCode)
          throw new Error(`Setup failed (${result.exitCode})`);
      }
      for (let turnIndex = 0; turnIndex < this.task.maxTurns; turnIndex++) {
        if (Date.now() - this.started > this.task.timeout)
          throw new Error(`Run timed out after ${this.task.timeout}ms`);
        await this.injectNextUserMessage(false);
        await this.trace("model_request", {
          turn: turnIndex,
          messages: this.messages,
          model: this.task.modelProfile,
        });
        let recordedFirstToken = false;
        const turn = await this.model.complete(this.messages, {
          signal: this.aborter.signal,
          onFirstToken: () => {
            if (recordedFirstToken) return;
            recordedFirstToken = true;
            void this.trace("model_first_token", { turn: turnIndex });
          },
          onDelta: (text) => {
            void this.trace("model_delta", { text });
          },
        });
        await this.trace("model_response", {
          content: turn.content,
          reasoning: turn.reasoning,
          toolCalls: turn.toolCalls,
          usage: turn.usage,
        });
        this.messages.push({
          role: "assistant",
          content: turn.content,
          toolCalls: turn.toolCalls,
        });
        if (!turn.toolCalls.length) {
          if (await this.injectNextUserMessage(true)) continue;
          this.acceptingMessages = false;
          // Close the small await boundary above without losing a message that
          // arrived just before the run stopped accepting new input.
          if (this.steeredMessages.length || this.queuedMessages.length) {
            this.acceptingMessages = true;
            await this.injectNextUserMessage(true);
            continue;
          }
          const grader = [];
          for (const command of this.task.grader) {
            const result = await this.hostShell.execute(
              command,
              this.task.toolTimeout,
              this.aborter.signal,
            );
            grader.push({ command, result });
            await this.trace("grader", { command, result });
          }
          const passed = grader.every((item) => item.result.exitCode === 0);
          const result = JSON.stringify({
            answer: turn.content,
            graderPassed: passed,
            grader,
          });
          await this.trace("run_finished", {
            answer: turn.content,
            graderPassed: passed,
          });
          // A terminal status means the sandboxed process and its ACL grants
          // have actually been released; callers may safely move/delete the
          // workspace as soon as they observe completion.
          await this.shell.close();
          await this.hostShell.close();
          this.store.updateRun(
            this.id,
            passed ? "completed" : "failed",
            result,
            passed ? undefined : "Grader failed",
          );
          return result;
        }
        for (const call of turn.toolCalls) {
          await this.trace("tool_call", { ...call });
          let output: string;
          try {
            output = await this.execute(call);
          } catch (error) {
            if (error instanceof SandboxUnavailableError) throw error;
            output = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
          await this.trace("tool_result", {
            toolCallId: call.id,
            name: call.name,
            output,
          });
          this.messages.push({
            role: "tool",
            name: call.name,
            toolCallId: call.id,
            content: output,
          });
        }
        // Fence warnings ride as user messages after the tool results, so the
        // tool_call → tool_result adjacency required by the wire protocol holds.
        await this.flushBoundaryWarnings();
      }
      throw new Error(`Maximum turns exceeded (${this.task.maxTurns})`);
    } catch (error) {
      failed = true;
      primary = error;
      this.acceptingMessages = false;
      const cancelled = this.aborter.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateRun(
        this.id,
        cancelled ? "cancelled" : "failed",
        undefined,
        message,
      );
      await this.trace("run_failed", { cancelled, error: message });
    } finally {
      // Any approval still pending would otherwise keep its caller suspended
      // after the run record reached a terminal status.
      this.approvals.cancelRun(this.id);
      const closeErrors: unknown[] = [];
      for (const shell of [this.shell, this.hostShell]) {
        try {
          await shell.close();
        } catch (error) {
          closeErrors.push(error);
        }
      }
      // Cleanup failures never mask the run's own failure; on a clean run
      // they are the only failure left, so surface them.
      if (closeErrors.length && !failed)
        throw new AggregateError(closeErrors, "Shell cleanup failed");
    }
    if (failed) throw primary;
    // The turn loop always returns its result or throws; reaching here means
    // cleanup swallowed control flow, which should never happen.
    throw new Error("Run loop exited without a result");
  }
}

export class RunManager {
  readonly approvals: ApprovalQueue;
  private active = new Map<string, HarnessRun>();
  constructor(readonly store: TraceStore) {
    this.approvals = new ApprovalQueue(store, (request, state, allow) => {
      void store.append(request.runId, `approval_${state}`, { request, allow });
    });
  }
  start(task: TaskDefinition, apiKey: string, options: { appendAdhdSkill?: boolean } = {}) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: RunRecord = {
      id,
      status: "queued",
      task,
      createdAt: now,
      updatedAt: now,
    };
    this.store.createRun(record);
    try {
      // Per-run append (chat toggle) composes on top of the stored custom
      // prompt or the default; the settings injection lives in the store.
      let systemPrompt = this.store.getSetting("systemPrompt") ?? SYSTEM_PROMPT;
      if (options.appendAdhdSkill) systemPrompt = `${systemPrompt}\n\n${ADHD_SKILL}`;
      const run = new HarnessRun(task, apiKey, this.store, this.approvals, id, systemPrompt);
      this.active.set(id, run);
      void run
        .run()
        .catch(() => {})
        .finally(() => this.active.delete(id));
    } catch (error) {
      // HarnessRun construction validates the workspace; a rejection there
      // must land on the already-persisted record instead of escaping start.
      this.store.updateRun(
        id,
        "failed",
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
    }
    return record;
  }
  cancel(id: string) {
    const run = this.active.get(id);
    if (!run) return false;
    run.cancel();
    return true;
  }
  enqueueMessage(id: string, content: string, mode: "queue" | "steer") {
    return this.active.get(id)?.enqueueMessage(content, mode) ?? false;
  }
}






