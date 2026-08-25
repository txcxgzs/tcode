import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import * as nodePty from "node-pty";
import type { IPty } from "node-pty";
import { AclWriteGrant, tempWriteSid, workspaceWriteSid } from "@deepseek-ai/dsh-sandbox-windows-acl";
import type { SandboxMode } from "./permissions.js";

export interface ShellResult {
  output: string;
  exitCode: number;
  truncated: boolean;
  stateReset: boolean;
  sandbox: { mode: SandboxMode; backend: string; enforcement: "full" | "partial" | "none" };
}
export interface ShellAdapter {
  execute(command: string, timeoutMs: number, signal?: AbortSignal): Promise<ShellResult>;
  close(): Promise<void>;
}

export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE";
  constructor(detail: string) {
    super(`Sandbox unavailable: ${detail}`);
    this.name = "SandboxUnavailableError";
  }
}

const require = createRequire(import.meta.url);

// Resolve pwsh: PowerShell 7 first, then PATH entries, then Windows PowerShell 5.1.
// Mirrors dsh-pwsh-local's resolvePwshPath ordering. lstat (not stat) so the
// Microsoft Store execution alias is seen even when its target ACL would EACCES.
function resolvePwshPath(): string {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const candidates = [join(programFiles, "PowerShell", "7", "pwsh.exe")];
  for (const entry of (process.env.PATH ?? "").split(";")) {
    const trimmed = entry.trim().replace(/^"|"$/g, "");
    if (trimmed.length === 0) continue;
    candidates.push(join(trimmed, "pwsh.exe"));
  }
  candidates.push(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  for (const candidate of candidates) {
    try { if (existsSync(candidate) && lstatSync(candidate)) return candidate; } catch { /* keep scanning */ }
  }
  return "powershell.exe";
}

const PWSH_ARGS = ["-NoLogo", "-NoProfile"];

// The controlled prompt emitted after every command. Readiness waits for it;
// the completion marker arrives as its own Write-Output line, distinct from
// the prompt because it carries a UUID the echo cannot forge.
const CONTROLLED_PROMPT = "dsh> ";

// Mirrors bash.ts SHELL_RESET_MESSAGE: surfaced to the model when the persistent
// session was forcibly reset (timeout or crash) so it knows cwd/env are gone.
const SHELL_RESET_MESSAGE = "The persistent PowerShell session was reset; the next call starts from the workspace with a fresh current directory and environment.";

// Strip ANSI/OSC/CSI escape sequences and VT control bytes from ConPTY output.
// ConPTY injects screen-clear, cursor-home, title-bar OSC, and cursor-visibility
// sequences; PSReadLine adds syntax-coloring sequences around echoed input.
const VT_ESCAPE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07?|\x1b[=>]|\x07/g;
function stripVt(text: string): string {
  return text.replace(VT_ESCAPE, "");
}

export class PersistentPowerShell implements ShellAdapter {
  private pty?: IPty;
  private lines = new EventEmitter();
  private buffer = "";
  private capture = "";  // unbounded stripped accumulator, never drained by drainLines
  private closed = false;
  private ready = false;
  private tempDir?: string;
  private workspaceGrant?: AclWriteGrant;
  private tempGrant?: AclWriteGrant;
  private readonly workspace: string;

  constructor(workspace: string, private maxOutput = 200_000, private mode: SandboxMode = "danger-full-access") {
    this.workspace = realpathSync.native(workspace);
  }

  private sandboxFacts(): ShellResult["sandbox"] {
    return this.mode === "danger-full-access"
      ? { mode: this.mode, backend: "none", enforcement: "none" }
      : { mode: this.mode, backend: "dsh-windows-acl", enforcement: "partial" };
  }

  private provisionWindowsAcl() {
    if (process.platform !== "win32") {
      throw new SandboxUnavailableError(`mode ${this.mode} has no supported backend on ${process.platform}`);
    }
    if (this.tempDir) return;
    this.tempDir = mkdtempSync(join(tmpdir(), "tcode-sandbox-"));
    if (this.mode === "workspace-write") {
      const workspaceGrant = AclWriteGrant.create(workspaceWriteSid(this.workspace));
      const tempGrant = AclWriteGrant.create(tempWriteSid(this.tempDir));
      try {
        workspaceGrant.add(this.workspace, true);
        tempGrant.add(this.tempDir, false);
        this.workspaceGrant = workspaceGrant;
        this.tempGrant = tempGrant;
      } catch (error) {
        try { tempGrant.dispose(); } catch { /* preserve the provisioning error */ }
        try { workspaceGrant.dispose(); } catch { /* preserve the provisioning error */ }
        throw error;
      }
    }
  }

  // Build the argv to spawn. For confined modes the DSH ACL runner wraps the
  // pwsh argv; the runner uses stdio:inherit so ConPTY bytes pass through to
  // pwsh. node-pty owns the ConPTY one level up — the runner uses
  // CreateProcessAsUserW, not ConPTY.
  private spawnArgv(): { file: string; args: string[] } {
    const pwsh = resolvePwshPath();
    if (this.mode === "danger-full-access") return { file: pwsh, args: PWSH_ARGS };
    this.provisionWindowsAcl();
    const runner = require.resolve("@deepseek-ai/dsh-sandbox-windows-acl/runner");
    const runnerArgs = [runner, "--workspace", this.workspace, "--temp", this.tempDir!, "--mode", this.mode];
    if (this.mode === "workspace-write") {
      runnerArgs.push("--write-sid", workspaceWriteSid(this.workspace), "--temp-write-sid", tempWriteSid(this.tempDir!));
    }
    runnerArgs.push("--", pwsh, ...PWSH_ARGS);
    return { file: process.execPath, args: runnerArgs };
  }

  private start() {
    if (this.closed) throw new Error("Shell is closed");
    if (this.pty) return;
    const { file, args } = this.spawnArgv();
    this.buffer = "";
    this.capture = "";
    this.ready = false;
    this.pty = nodePty.spawn(file, args, {
      name: "dumb",
      cols: 200,
      rows: 50,
      cwd: this.workspace,
      env: process.env as Record<string, string>,
    });
    const pty = this.pty;
    pty.onData((chunk: string) => {
      // Guard against stale data from a killed PTY flushing after reset:
      // onExit is identity-guarded (exited === pty); onData must be too, or
      // a dying PTY's tail bytes would land in the new session's capture and
      // could spuriously satisfy waitForReady before the new setup installs.
      if (this.pty !== pty) return;
      const clean = stripVt(chunk);
      this.capture += clean;
      this.buffer += clean;
      this.drainLines();
      this.lines.emit("data");
    });
    pty.onExit(({ exitCode }) => {
      this.lines.emit("exit", pty, exitCode);
    });
  }

  // Split on \r or \n: ConPTY emits \r\n for most output, but a prompt
  // function's [Console]::Write can emit a bare \r before the prompt text,
  // and PSReadLine's echo uses \r\n. Treating either as a line boundary keeps
  // the prompt and the echoed command on separate lines.
  private drainLines() {
    let index: number;
    while ((index = this.buffer.search(/[\r\n]/)) >= 0) {
      const sep = this.buffer[index];
      const line = this.buffer.slice(0, index);
      // Skip an empty line produced by the \r of a \r\n pair, but keep genuinely
      // empty lines so command output blanks survive.
      const next = this.buffer[index + 1];
      if (sep === "\r" && next === "\n") this.buffer = this.buffer.slice(index + 2);
      else this.buffer = this.buffer.slice(index + 1);
      this.lines.emit("line", line);
    }
  }

  // Install the controlled prompt + UTF-8 pin, then trigger it with an empty
  // submit. PowerShell does not re-render the prompt after a function definition
  // alone — it only shows the new prompt when the next command (even empty)
  // completes and prompt runs. Mirrors DSH terminal-bash startupSession, which
  // loops sending empty submits until the controlled prompt is visible.
  private async waitForReady(signal?: AbortSignal): Promise<void> {
    if (this.ready) return;
    const pty = this.pty!;
    // Remove PSReadLine so it does not re-echo submitted commands back into the
    // output stream with syntax coloring and line-wrapping — that echo embeds
    // the wrapper (and its markers) mid-stream and corrupts marker extraction.
    // The encoding pin and OSC 133 prompt marker touch .NET types that
    // ConstrainedLanguage mode (read-only sandbox) blocks, so wrap each in
    // try/catch. The prompt function itself must still install and return the
    // controlled prompt string — readiness detection depends on it.
    const setup = `Remove-Module PSReadLine -ErrorAction SilentlyContinue; try { [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[System.Text.UTF8Encoding]::new($false) } catch {}; function prompt { try { [Console]::Write([char]27+']133;D;'+[int]($global:LASTEXITCODE??0)+[char]7) } catch {}; '${CONTROLLED_PROMPT}' }`;
    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      let nudged = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(nudgeTimer);
        signal?.removeEventListener("abort", abort);
        this.lines.off("data", onData);
        this.lines.off("data", nudgeCheck);
        this.lines.off("exit", onExit);
        error ? reject(error) : resolve();
      };
      // Check the stripped buffer (not line events) for the controlled prompt:
      // the prompt function writes 'dsh> ' without a trailing newline, and
      // chunk/line boundaries make per-line matching unreliable. The echoed
      // setup line contains 'dsh> ' inside quotes ('dsh> ' }), so a real prompt
      // is one NOT immediately followed by a quote or brace.
      const onData = () => {
        const idx = this.capture.lastIndexOf(CONTROLLED_PROMPT);
        if (idx < 0) return;
        const after = this.capture.slice(idx + CONTROLLED_PROMPT.length);
        if (after.startsWith("'") || after.startsWith("}")) return;
        this.ready = true;
        finish();
      };
      const onExit = (exited: IPty) => { if (exited === pty) finish(new Error("PowerShell exited during startup")); };
      const abort = () => finish(new Error("Shell startup cancelled"));
      let nudgeTimer: NodeJS.Timeout;
      // After setup is echoed, nudge with an empty \r to trigger prompt render.
      const nudgeCheck = () => {
        if (nudged || settled) return;
        if (this.capture.includes("function prompt")) {
          nudged = true;
          nudgeTimer = setTimeout(() => { try { pty.write("\r"); } catch { /* gone */ } }, 300);
        }
      };
      this.lines.on("data", onData);
      this.lines.on("data", nudgeCheck);
      this.lines.on("exit", onExit);
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => finish(new Error("PowerShell did not reach readiness before startup timeout")), 30_000);
      // Submit with \r (carriage return), NOT \n: a terminal's Enter key is
      // \r. \n is a line feed that PSReadLine treats as multi-line input and
      // answers with a `>>` continuation prompt, hanging readiness forever.
      try {
        pty.write(setup + "\r");
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async execute(command: string, timeoutMs: number, signal?: AbortSignal): Promise<ShellResult> {
    if (this.closed) throw new Error("Shell is closed");
    this.start();
    await this.waitForReady(signal);
    const pty = this.pty!;
    // Start and end markers bracket the command output. ConPTY echoes the
    // submitted wrapper back into the stream, so any marker text that appears
    // literally in the wrapper source also appears in the echo — making the
    // real output and the echo indistinguishable. Build the markers from
    // [char[]] code units at runtime so the literal marker string only appears
    // in the Write-Output RESULT, never in the echoed source line.
    const nonce = randomUUID().replaceAll("-", "");
    const startMarker = `__TCODE_START_${nonce}__`;
    const endMarker = `__TCODE_END_${nonce}__`;
    const charCodes = (s: string): string => Array.from(s).map((ch) => ch.charCodeAt(0)).join(",");
    const startMarkerCodes = charCodes(startMarker);
    const endMarkerCodes = charCodes(endMarker);
    // Encode the command as UTF-16 code units built from [char] so it survives
    // PSReadLine's input processing and works in ConstrainedLanguage mode.
    // The entire wrapper is a SINGLE physical line — no bare newlines, or
    // PSReadLine shows a `>>` continuation prompt and markers never arrive.
    const units: number[] = [];
    const bytes = Buffer.from(command, "utf16le");
    for (let index = 0; index < bytes.length; index += 2) units.push(bytes.readUInt16LE(index));
    const body = units.join(",");
    const wrapper = `Write-Output (-join [char[]](${startMarkerCodes}));$global:LASTEXITCODE=$null;$e=0;$err=$null;$oldEap=$ErrorActionPreference;try{$ErrorActionPreference='Stop';$c=-join [char[]](${body});Invoke-Expression $c;if($null -ne $global:LASTEXITCODE){$e=$global:LASTEXITCODE}}catch{$err=$_;$e=1}finally{$ErrorActionPreference=$oldEap};if($null -ne $err){Write-Output $err.Exception.Message};Write-Output (-join [char[]](${endMarkerCodes})+[string]$e)`;
    // Record the capture offset at send time so we only scan new output for markers.
    const sendOffset = this.capture.length;
    return await new Promise<ShellResult>((resolve, reject) => {
      let settled = false;
      // Extract output between markers from the capture since sendOffset. When
      // the end marker is present, also parse the exit code from the digits
      // following it. When only the start marker is present (command produced
      // output then timed out / crashed before completing), return everything
      // from the start marker to the capture tail as partial output.
      const extract = (): { output: string; exitCode: number | null } => {
        const text = this.capture.slice(sendOffset);
        const endIdx = text.lastIndexOf(endMarker);
        if (endIdx >= 0) {
          const statusMatch = /^(\d+)/.exec(text.slice(endIdx + endMarker.length));
          const exitCode = statusMatch ? Number(statusMatch[1]) : 0;
          const startIdx = text.indexOf(startMarker);
          const raw = startIdx >= 0 && startIdx < endIdx
            ? text.slice(startIdx + startMarker.length, endIdx)
            : text.slice(0, endIdx);
          return { output: raw.replace(/^\r?\n/, "").replace(/\r?\n?$/, ""), exitCode };
        }
        // No end marker: command hasn't completed. If a start marker arrived,
        // everything after it is partial output (timed-out or crashed mid-command).
        const startIdx = text.indexOf(startMarker);
        if (startIdx >= 0) {
          const raw = text.slice(startIdx + startMarker.length);
          return { output: raw.replace(/^\r?\n/, "").replace(/\r?\n?$/, ""), exitCode: null };
        }
        return { output: "", exitCode: null };
      };
      const finish = (error?: Error, exitCode = 1, stateReset = false, presetOutput?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.lines.off("data", onData);
        this.lines.off("exit", onExit);
        if (error) { reject(error); return; }
        let output: string;
        let resolvedExit = exitCode;
        if (presetOutput !== undefined) {
          // Graceful reset (timeout/crash): reset() already built the notice
          // from whatever output arrived before the session died.
          output = presetOutput;
        } else {
          const { output: extracted, exitCode: parsed } = extract();
          output = extracted;
          if (parsed !== null) resolvedExit = parsed;
        }
        const truncated = output.length > this.maxOutput;
        if (truncated) output = `${output.slice(0, this.maxOutput)}\n[output truncated: ${output.length - this.maxOutput} characters omitted]`;
        // Trim the unbounded capture accumulator: keep only a bounded tail so it
        // does not grow without limit across hundreds of commands in a long
        // session. The tail retains the trailing prompt for waitForReady and
        // resets the next sendOffset to ~0 since old content is dropped.
        const keep = Math.min(this.capture.length, Math.max(this.maxOutput * 2, 4096));
        if (keep < this.capture.length) this.capture = this.capture.slice(this.capture.length - keep);
        resolve({ output, exitCode: resolvedExit, truncated, stateReset, sandbox: this.sandboxFacts() });
      };
      // reset kills the PTY and resolves/rejects depending on cause. Timeouts
      // and unexpected exits resolve with partial output + a reset notice
      // (mirroring bash.ts), so the model sees what happened and knows its
      // persistent state is gone. Cancellation rejects (a deliberate user abort).
      const reset = (message: string, code = 124, doReject = false) => {
        if (this.pty === pty) { this.pty = undefined; this.ready = false; }
        try { pty.kill(); } catch { /* already gone */ }
        if (doReject) { finish(new Error(message), code, true); return; }
        // Graceful reset (timeout/crash): return whatever output arrived so far
        // plus the reset notice. extract() captures partial output even when the
        // end marker never arrived (command timed out mid-execution).
        const { output: partial } = extract();
        const notice = code === 124
          ? `Your command timed out after ${Math.round(timeoutMs / 1000)} seconds. Below is partial output:\n${partial}\n${SHELL_RESET_MESSAGE}`
          : `${partial}\n${SHELL_RESET_MESSAGE}`;
        finish(undefined, code, true, notice);
      };
      const onData = () => {
        const text = this.capture.slice(sendOffset);
        // The end marker followed by digits signals completion. The marker is
        // built from char codes so only the real Write-Output produces it.
        const idx = text.lastIndexOf(endMarker);
        if (idx < 0) return;
        if (!/^\d/.test(text.slice(idx + endMarker.length))) return;
        finish(undefined, 0);
      };
      const onExit = (exited: IPty, code: number) => {
        if (exited === pty) reset("PowerShell session exited unexpectedly", code ?? 1);
      };
      const abort = () => reset("Shell command cancelled; persistent state was reset", 124, true);
      const timer = setTimeout(() => reset(`Shell command timed out after ${timeoutMs}ms; persistent state was reset`), timeoutMs);
      this.lines.on("data", onData);
      this.lines.on("exit", onExit);
      signal?.addEventListener("abort", abort, { once: true });
      // Submit with \r (carriage return) — see waitForReady. If the write
      // throws (PTY gone), reset so listeners/timer are cleaned up.
      try {
        pty.write(wrapper + "\r");
      } catch (error) {
        reset(error instanceof Error ? error.message : String(error), 1, true);
      }
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const cleanupErrors: unknown[] = [];
    const pty = this.pty;
    if (pty) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
        pty.onExit(() => finish());
        try { pty.write("exit\r"); } catch { /* may already be gone */ }
        const timer = setTimeout(() => { try { pty.kill(); } catch { /* already gone */ } finish(); }, 3_000);
      });
      this.pty = undefined;
    }
    try { this.tempGrant?.dispose(); } catch (error) { cleanupErrors.push(error); }
    this.tempGrant = undefined;
    try { this.workspaceGrant?.dispose(); } catch (error) { cleanupErrors.push(error); }
    this.workspaceGrant = undefined;
    try {
      if (this.tempDir) rmSync(this.tempDir, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
    this.tempDir = undefined;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Failed to clean up Windows ACL sandbox");
  }
}
