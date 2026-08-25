import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { escapesWorkspace, inside, normalizePermissionMode, resolvePermissionPolicy } from "../src/permissions.js";

describe("DSH-compatible permission policy", () => {
  it("keeps sandbox mode and approval policy orthogonal", () => {
    expect(resolvePermissionPolicy("workspace-write")).toEqual({ sandboxMode: "workspace-write", approvalPolicy: "ask" });
    expect(resolvePermissionPolicy("danger-full-access")).toEqual({ sandboxMode: "danger-full-access", approvalPolicy: "never" });
    expect(resolvePermissionPolicy("read-only")).toEqual({ sandboxMode: "read-only", approvalPolicy: "never" });
  });

  it("migrates old UI preset names without treating them as security mechanisms", () => {
    expect(normalizePermissionMode("review")).toBe("workspace-write");
    expect(normalizePermissionMode("full-access")).toBe("danger-full-access");
    expect(() => normalizePermissionMode("made-up")).toThrow(/Unknown permission preset/);
  });

  it("checks workspace containment lexically", () => {
    expect(inside("C:\\work\\repo", "C:\\work\\repo\\src")).toBe(true);
    expect(inside("C:\\work\\repo", "C:\\work\\other")).toBe(false);
  });

  it("detects lexical and symlinked boundary escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcode-fence-"));
    const outside = await mkdtemp(join(tmpdir(), "tcode-fence-out-"));
    try {
      await mkdir(join(root, "pkg"), { recursive: true });
      await writeFile(join(root, "pkg", "file.ts"), "x");
      await writeFile(join(outside, "secret.txt"), "x");
      expect(await escapesWorkspace(root, join(root, "pkg", "file.ts"))).toBe(false);
      expect(await escapesWorkspace(root, join(root, "not-created-yet.txt"))).toBe(false);
      expect(await escapesWorkspace(root, join(outside, "secret.txt"))).toBe(true);
      // A symlink inside the workspace pointing outside must count as escape.
      await symlink(outside, join(root, "link-out"), process.platform === "win32" ? "junction" : "dir");
      expect(await escapesWorkspace(root, join(root, "link-out", "secret.txt"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
