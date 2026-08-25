import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PersistentPowerShell } from "../src/shell.js";

let shell: PersistentPowerShell | undefined;
const roots: string[] = [];

afterEach(async () => {
  await shell?.close();
  shell = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "win32")("DSH Windows ACL sandbox", () => {
  it("allows workspace writes and denies writes outside it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tcode-sandbox-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "tcode-sandbox-outside-"));
    roots.push(workspace, outside);
    shell = new PersistentPowerShell(workspace, 200_000, "workspace-write");

    const inside = await shell.execute("Set-Content -LiteralPath inside.txt -Value ok", 30_000);
    expect(inside.exitCode).toBe(0);
    expect(inside.sandbox).toEqual({ mode: "workspace-write", backend: "dsh-windows-acl", enforcement: "partial" });
    expect((await readFile(join(workspace, "inside.txt"), "utf8")).trim()).toBe("ok");

    const outsideFile = join(outside, "blocked.txt").replaceAll("'", "''");
    const denied = await shell.execute(`Set-Content -LiteralPath '${outsideFile}' -Value blocked`, 30_000);
    expect(denied.exitCode).not.toBe(0);
    await expect(access(join(outside, "blocked.txt"))).rejects.toThrow();
  }, 60_000);

  it("denies writes in read-only mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tcode-sandbox-readonly-"));
    roots.push(workspace);
    shell = new PersistentPowerShell(workspace, 200_000, "read-only");
    const denied = await shell.execute("Set-Content -LiteralPath blocked.txt -Value blocked", 30_000);
    expect(denied.exitCode).not.toBe(0);
    expect(denied.sandbox.enforcement).toBe("partial");
    await expect(access(join(workspace, "blocked.txt"))).rejects.toThrow();
  }, 60_000);
});
