import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentBash } from "../src/bash.js";
import { SandboxUnavailableError } from "../src/shell.js";

let root = "";
let bash: PersistentBash | undefined;
afterEach(async () => { await bash?.close(); if (root) await rm(root, { recursive: true, force: true }); });

describe.runIf(process.platform === "win32")("DSH persistent bash", () => {
  it("preserves cwd and exported environment variables", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-bash-"));
    bash = new PersistentBash(root);
    expect((await bash.execute("mkdir -p child && cd child && export TCODE_BASH_STATE=kept", 5_000)).exitCode).toBe(0);
    const result = await bash.execute("printf '%s|%s' \"$PWD\" \"$TCODE_BASH_STATE\"", 5_000);
    expect(result.output.replaceAll("\\", "/")).toContain("/child|kept");
  });

  it("returns the command exit code and marks only failures", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-bash-"));
    bash = new PersistentBash(root);
    expect((await bash.execute("false", 5_000)).exitCode).toBe(1);
    expect((await bash.execute("false", 5_000)).output).toBe("[exit code: 1]");
    const success = await bash.execute("printf quiet", 5_000);
    expect(success.exitCode).toBe(0);
    expect(success.output).toBe("quiet");
    const noisy = await bash.execute("sh -c 'echo oops >&2; exit 3'", 5_000);
    expect(noisy.exitCode).toBe(3);
    expect(noisy.output).toContain("oops");
    expect(noisy.output.trimEnd().endsWith("[exit code: 3]")).toBe(true);
  });

  it("returns partial output with a reset notice on timeout, then recovers", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-bash-"));
    bash = new PersistentBash(root);
    const result = await bash.execute("echo started; sleep 5", 1_000);
    expect(result.output).toContain("Your command timed out after 1 seconds or experienced an OOM error. Below is partial output:");
    expect(result.output).toContain("started");
    expect(result.output).toContain("The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.");
    expect(result.stateReset).toBe(true);
    expect((await bash.execute("printf recovered", 5_000)).output).toBe("recovered");
  });

  it("clips output at the DSH minimal 16k budget with the grep-narrowing NOTE", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-bash-"));
    bash = new PersistentBash(root);
    const result = await bash.execute("seq 1 6000", 5_000);
    expect(result.output.length).toBeLessThanOrEqual(16_000 + 300);
    expect(result.output).toContain("<response clipped>");
    expect(result.output).toContain("You should retry this tool after you have searched inside the file with `grep -n`");
    expect(result.truncated).toBe(true);
  });

  it("runs sandboxed commands through BusyBox inside workspace-write", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-bash-acl-"));
    bash = new PersistentBash(root, 16_000, "workspace-write");
    const result = await bash.execute("printf sandboxed > fallback.txt && cat fallback.txt", 10_000);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("sandboxed");
    expect(result.sandbox).toEqual({ mode: "workspace-write", backend: "dsh-windows-acl", enforcement: "partial" });
  }, 30_000);
  it("keeps bounded read pipelines stable inside workspace-write", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-bash-pipe-"));
    bash = new PersistentBash(root, 16_000, "workspace-write");
    for (let index = 0; index < 20; index++) {
      const result = await bash.execute("printf 'alpha\\nbeta\\n' | head -1", 10_000);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("alpha");
      expect(result.output).not.toContain("Bad file descriptor");
    }
  }, 60_000);
  it("runs npm through the Node CLI without Windows batch mojibake", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-bash-npm-"));
    bash = new PersistentBash(root, 16_000, "workspace-write");
    const result = await bash.execute("npm --version 2>&1 | head -1", 20_000);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.output).not.toContain("���");
    expect(result.output).not.toContain("Bad file descriptor");
  }, 30_000);
  it("reports an unexpected shell exit with partial output and resets", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-bash-"));
    bash = new PersistentBash(root);
    const result = await bash.execute("echo last; exit 7", 5_000);
    expect(result.output).toContain("last");
    expect(result.output).toContain("[shell exited: code 7]");
    expect(result.output).toContain("The persistent bash shell was reset");
    expect(result.stateReset).toBe(true);
    expect((await bash.execute("printf fresh", 5_000)).output).toBe("fresh");
  });
});

