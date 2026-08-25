import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { AclWriteGrant, tempWriteSid, workspaceWriteSid } from "@deepseek-ai/dsh-sandbox-windows-acl";
import type { SandboxMode } from "./permissions.js";
import type { ShellAdapter, ShellResult } from "./shell.js";
import { SandboxUnavailableError } from "./shell.js";

const require = createRequire(import.meta.url);
const GIT_BASH = [
  process.env.TCODE_BASH_PATH,
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
].find((path): path is string => Boolean(path && existsSync(path)));
const BUSYBOX = [
  process.env.TCODE_BUSYBOX_PATH,
  join(process.cwd(), ".tcode", "busybox64u.exe"),
].find((path): path is string => Boolean(path && existsSync(path)));

// Mirrors @deepseek-ai/dsh-tool-bash-persistent so models see the same
// result contract: tail-clipped output with a grep-narrowing hint, a trailing
// [exit code: N] marker only for failures, and explicit reset notices.
const TRUNCATED_MESSAGE = '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>';
const SHELL_RESET_MESSAGE = 'The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.';
const CYGWIN_SANDBOX_FAILURE = /(?:cygheap_(?:user::init|heap_init)|couldn't create signal pipe|CreateFileMapping S-1-).*?(?:Win32 error 5|0xC0000022|0xC0000142)/is;

function maybeTruncate(content: string, maxOutputChars: number, incomplete = false): string {
  if (content.length <= maxOutputChars && !incomplete) return content;
  return content.length <= maxOutputChars
    ? content + TRUNCATED_MESSAGE
    : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE;
}

function appendStatusMarker(content: string, marker: string | undefined): string {
  if (marker === undefined) return content;
  return content.length === 0 ? marker : `${content}\n${marker}`;
}

function renderCaptured(output: string, exitCode: number | undefined, maxOutputChars: number): string {
  const rendered = maybeTruncate(output, maxOutputChars);
  const marker = exitCode !== undefined && exitCode !== 0
    ? `[exit code: ${exitCode}]`
    : undefined;
  return appendStatusMarker(rendered, marker);
}

function renderShellExitStatus(content: string, exitCode: number | null, signal: NodeJS.Signals | null): string {
  const marker = signal !== null
    ? `[shell killed by signal: ${signal}]`
    : exitCode !== null
      ? `[shell exited: code ${exitCode}]`
      : "[shell exited]";
  return appendStatusMarker(content, marker);
}

// BusyBox ash cannot reliably create anonymous pipes under the Windows
// WRITE_RESTRICTED token. Preserve the overwhelmingly common bounded-read
// pipeline (`grep/cat/rg ... | head/tail`) by materializing its left side in
// the sandbox-private temp directory instead of creating an OS pipe.
function rewriteBoundedReadPipelines(command: string) {
  const clauses: Array<{ text: string; separator: string }> = [];
  let quote = "", escaped = false, start = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    const separator = ch === ";" || ch === "\n" ? ch : ch === "&" && command[i + 1] === "&" ? "&&" : "";
    if (!separator) continue;
    clauses.push({ text: command.slice(start, i), separator });
    if (separator === "&&") i++;
    start = i + 1;
  }
  clauses.push({ text: command.slice(start), separator: "" });

  return clauses.map(({ text, separator }) => {
    let innerQuote = "", innerEscaped = false, pipe = -1, pipeCount = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (innerEscaped) { innerEscaped = false; continue; }
      if (ch === "\\" && innerQuote !== "'") { innerEscaped = true; continue; }
      if (innerQuote) { if (ch === innerQuote) innerQuote = ""; continue; }
      if (ch === "'" || ch === '"') { innerQuote = ch; continue; }
      if (ch === "|" && text[i + 1] !== "|") { pipe = i; pipeCount++; }
    }
    if (pipeCount !== 1) return text + separator;
    const right = text.slice(pipe + 1).trim();
    if (!/^(?:head|tail)(?:\s+(?:-n\s*)?-?\d+)?\s*$/.test(right)) return text + separator;
    const left = text.slice(0, pipe).trim();
    if (!left) return text + separator;
    const temp = `$TMP/tcode-pipe-${randomUUID().replaceAll("-", "")}.txt`;
    return `{ ${left}; } > "${temp}" && ${right} "${temp}"${separator}`;
  }).join("");
}

function rewriteWindowsNodeLaunchers(command: string) {
  if (process.platform !== "win32") return command;
  const node = process.execPath.replaceAll("\\", "/");
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js").replaceAll("\\", "/");
  const npxCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js").replaceAll("\\", "/");
  const replace = (source: string, name: "npm" | "npx", cli: string) => source.replace(
    new RegExp(`(^|(?:&&|;|\\n)\\s*)(?:"?[^"\\s;|]*[\\\\/])?${name}(?:\\.cmd)?(?=\\s|$)`, "gi"),
    (_match, prefix: string) => `${prefix}"${node}" "${cli}"`,
  );
  return replace(replace(command, "npm", npmCli), "npx", npxCli);
}

export class PersistentBash implements ShellAdapter {
  private child?: ChildProcessWithoutNullStreams;
  private lines = new EventEmitter();
  private buffer = "";
  private stderr = "";
  private closed = false;
  private tempDir?: string;
  private workspaceGrant?: AclWriteGrant;
  private tempGrant?: AclWriteGrant;
  private readonly workspace: string;

  constructor(workspace: string, private maxOutput = 16_000, private mode: SandboxMode = "danger-full-access") {
    this.workspace = realpathSync.native(workspace);
    if (this.mode === "danger-full-access" && !GIT_BASH) {
      throw new Error("DSH Minimal requires Git Bash; set TCODE_BASH_PATH to a real bash executable");
    }
    if (this.mode !== "danger-full-access" && !BUSYBOX) {
      throw new SandboxUnavailableError("Windows ACL sandbox requires busybox-w32; set TCODE_BUSYBOX_PATH to busybox64u.exe");
    }
  }

  private sandboxFacts(): ShellResult["sandbox"] {
    return this.mode === "danger-full-access"
      ? { mode: this.mode, backend: "none", enforcement: "none" }
      : { mode: this.mode, backend: "dsh-windows-acl", enforcement: "partial" };
  }

  private provisionAcl() {
    if (process.platform !== "win32") throw new SandboxUnavailableError(`mode ${this.mode} has no supported backend on ${process.platform}`);
    if (this.tempDir) return;
    this.tempDir = mkdtempSync(join(tmpdir(), "tcode-bash-sandbox-"));
    if (this.mode === "workspace-write") {
      const workspaceGrant = AclWriteGrant.create(workspaceWriteSid(this.workspace));
      const tempGrant = AclWriteGrant.create(tempWriteSid(this.tempDir));
      try {
        workspaceGrant.add(this.workspace, true);
        tempGrant.add(this.tempDir, false);
        this.workspaceGrant = workspaceGrant;
        this.tempGrant = tempGrant;
      } catch (error) {
        try { tempGrant.dispose(); } catch {}
        try { workspaceGrant.dispose(); } catch {}
        throw error;
      }
    }
  }

  private start() {
    if (this.closed) throw new Error("Bash is closed");
    if (this.child && this.child.exitCode === null) return;
    let shell = this.mode === "danger-full-access" ? GIT_BASH! : BUSYBOX!;
    let command = shell;
    let args = this.mode === "danger-full-access" ? ["--noprofile", "--norc"] : ["ash"];
    if (this.mode !== "danger-full-access") {
      this.provisionAcl();
      const runner = require.resolve("@deepseek-ai/dsh-sandbox-windows-acl/runner");
      const runnerArgs = [runner, "--workspace", this.workspace, "--temp", this.tempDir!, "--mode", this.mode];
      if (this.mode === "workspace-write") runnerArgs.push("--write-sid", workspaceWriteSid(this.workspace), "--temp-write-sid", tempWriteSid(this.tempDir!));
      runnerArgs.push("--", shell, ...args);
      command = process.execPath;
      args = runnerArgs;
    }
    this.buffer = "";
    this.stderr = "";
    this.child = spawn(command, args, { cwd: this.workspace, stdio: "pipe", windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => { this.buffer += chunk; this.drainLines(); });
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    const spawned = this.child;
    spawned.on("exit", (code, signal) => this.lines.emit("exit", spawned, code, signal));
  }

  private drainLines() {
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.lines.emit("line", line);
    }
  }

  private async executeOnce(command: string, timeoutMs = 300_000, signal?: AbortSignal): Promise<ShellResult> {
    this.start();
    const child = this.child!;
    const marker = `__TCODE_END_${randomUUID().replaceAll("-", "")}__`;
    const chunks: string[] = [];
    this.stderr = "";
    return await new Promise<ShellResult>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, output = "", exitCode = 0, stateReset = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.lines.off("line", onLine);
        this.lines.off("exit", onExit);
        const truncated = output.length > this.maxOutput;
        error ? reject(error) : resolve({ output, exitCode, truncated, stateReset, sandbox: this.sandboxFacts() });
      };
      const captured = () => [...chunks, this.stderr.trim()].filter(Boolean).join("\n");
      const reset = (message: string, code = 124) => {
        if (this.child === child) this.child = undefined;
        if (!child.killed) child.kill();
        const detail = this.stderr.trim();
        if (/windows-acl-run:/i.test(detail) || (this.mode !== "danger-full-access" && CYGWIN_SANDBOX_FAILURE.test(detail))) {
          finish(new SandboxUnavailableError(detail || "Shell failed inside the Windows ACL sandbox"), "", code, true);
          return;
        }
        // Align with DSH: timeouts return partial output with a reset notice
        // instead of surfacing as an opaque harness error.
        if (code === 124 && message.includes("timed out")) {
          const partial = renderCaptured(captured(), undefined, this.maxOutput);
          const output = [
            `Your command timed out after ${Math.round(timeoutMs / 1000)} seconds or experienced an OOM error. Below is partial output:`,
            partial,
            SHELL_RESET_MESSAGE,
          ].filter((part) => part.length > 0).join("\n");
          finish(undefined, output, 124, true);
          return;
        }
        finish(new Error(message), "", code, true);
      };
      const onLine = (line: string) => {
        if (!line.startsWith(marker)) {
          chunks.push(line);
          return;
        }
        const exitCode = Number(line.slice(marker.length)) || 0;
        // The Windows ACL BusyBox runner leaks pipe handles in long-lived ash
        // sessions. A clean sandbox process per command prevents the eventual
        // `can't create pipe: Bad file descriptor` failure. Full-access Git
        // Bash remains persistent so cwd and exported variables are preserved.
        if (this.mode !== "danger-full-access" && this.child === child) {
          this.child = undefined;
          this.lines.off("exit", onExit);
          child.stdin.end("exit\n");
          child.once("exit", () => finish(undefined, renderCaptured(captured(), exitCode, this.maxOutput), exitCode));
          return;
        }
        finish(undefined, renderCaptured(captured(), exitCode, this.maxOutput), exitCode);
      };
      const onExit = (exited: ChildProcessWithoutNullStreams, code: number | null, exitSignal: NodeJS.Signals | null) => {
        if (exited !== child) return;
        if (this.child === child) this.child = undefined;
        const detail = this.stderr.trim();
        if (/windows-acl-run:/i.test(detail) || (this.mode !== "danger-full-access" && CYGWIN_SANDBOX_FAILURE.test(detail))) {
          finish(new SandboxUnavailableError(detail || "Shell failed inside the Windows ACL sandbox"), "", code ?? 1, true);
          return;
        }
        const partial = renderCaptured(captured(), undefined, this.maxOutput);
        const output = [
          renderShellExitStatus(partial, code, exitSignal),
          SHELL_RESET_MESSAGE,
        ].filter((part) => part.length > 0).join("\n");
        finish(undefined, output, code ?? 1, true);
      };
      const abort = () => reset("Bash command cancelled; persistent state was reset");
      const timer = setTimeout(() => reset(`Bash command timed out after ${timeoutMs}ms; persistent state was reset`), timeoutMs);
      this.lines.on("line", onLine);
      this.lines.on("exit", onExit);
      signal?.addEventListener("abort", abort, { once: true });
      const launcherSafeCommand = rewriteWindowsNodeLaunchers(command);
      const executableCommand = this.mode === "danger-full-access" ? launcherSafeCommand : rewriteBoundedReadPipelines(launcherSafeCommand);
      child.stdin.write(`${executableCommand}\n__tcode_exit=$?\nprintf '\\n%s%d\\n' '${marker}' "$__tcode_exit"\n`, "utf8");
    });
  }

  async execute(command: string, timeoutMs = 300_000, signal?: AbortSignal): Promise<ShellResult> {
    const first = await this.executeOnce(command, timeoutMs, signal);
    const pipeHandleFailure = /can't create pipe:\s*Bad file descriptor/i.test(first.output);
    // BusyBox ash under the Windows ACL runner can occasionally lose a pipe
    // handle after a long-lived session. Retry only obviously read-only
    // commands so a partial mutation can never be executed twice.
    const retryableRead = !/[><`;]|\$\(|\b(?:rm|mv|cp|mkdir|touch|chmod|chown|npm|pnpm|yarn|npx|git\s+(?!status\b|diff\b|log\b|show\b))\b/i.test(command);
    if (!pipeHandleFailure || !first.stateReset || !retryableRead || signal?.aborted) return first;
    return this.executeOnce(command, timeoutMs, signal);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (child && child.exitCode === null) {
      child.stdin.end("exit\n");
      await new Promise<void>((resolve) => { child.once("exit", () => resolve()); setTimeout(() => { if (!child.killed) child.kill(); resolve(); }, 3_000); });
    }
    try { this.tempGrant?.dispose(); } catch {}
    try { this.workspaceGrant?.dispose(); } catch {}
    if (this.tempDir) rmSync(this.tempDir, { recursive: true, force: true });
  }
}

