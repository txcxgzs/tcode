import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApprovalQueue } from "../src/runner.js";
import { TraceStore } from "../src/trace.js";

let root = "";
let store: TraceStore | undefined;
afterEach(async () => {
  store?.close();
  store = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("approval policy", () => {
  it("persists allow-similar rules across queues and workspaces", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-approval-"));
    store = await TraceStore.create(root);
    const first = new ApprovalQueue(store);
    // DSH mode: every workspace-write command shares one approval key, so a
    // single remembered allow covers all later pwsh commands in that run.
    const pending = first.request("run-a", "pwsh", '{"command":"Get-ChildItem"}', ["write"], false, "pwsh:command");
    const request = first.list("run-a")[0];
    expect(first.resolve(request.id, true, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    // A fresh queue (new run, same workspace settings) must honor the persisted rule.
    const second = new ApprovalQueue(store);
    expect(second.isAllowed("pwsh:command")).toBe(true);
    expect(second.isAllowed("pwsh:other")).toBe(false);
  });

  it("does not auto-allow under a different approval key", async () => {
    root = await mkdtemp(join(tmpdir(), "tcode-approval-2"));
    store = await TraceStore.create(root);
    const queue = new ApprovalQueue(store);
    const pending = queue.request("run-b", "pwsh", '{"command":"Set-Location"}', ["write"], false, "pwsh:command");
    const request = queue.list("run-b")[0];
    expect(queue.resolve(request.id, true, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    // editor keys are a separate namespace and must not inherit pwsh approval.
    expect(queue.isAllowed("editor:create")).toBe(false);
    expect(queue.isAllowed("editor:str_replace")).toBe(false);
  });
});
