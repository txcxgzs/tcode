import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { PermissionMode } from "./types.js";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "ask" | "never";

export interface ResolvedPermissionPolicy {
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
}

/**
 * DSH-compatible permission presets. Sandbox mode governs filesystem effects;
 * approval is a separate policy. Legacy names are accepted only to migrate
 * sessions created by earlier TCode builds.
 */
export function resolvePermissionPolicy(mode: PermissionMode | string): ResolvedPermissionPolicy {
  switch (mode) {
    case "danger-full-access":
    case "full-access":
      return { sandboxMode: "danger-full-access", approvalPolicy: "never" };
    case "read-only":
      // Pure autonomous reading: the sandbox already blocks every mutation,
      // so there is nothing left to approve.
      return { sandboxMode: "read-only", approvalPolicy: "never" };
    case "workspace-write":
    case "workspace-ask":
    case "outside-ask":
    case "review":
    case "ask-everything":
      return { sandboxMode: "workspace-write", approvalPolicy: "ask" };
    default:
      throw new Error(`Unknown permission preset: ${mode}`);
  }
}

export function normalizePermissionMode(mode: string): PermissionMode {
  return resolvePermissionPolicy(mode).sandboxMode;
}

export function inside(root: string, candidate: string) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * True when the requested path escapes the workspace, either lexically or
 * through a symlinked parent. Used for the boundary-warning fence: the model
 * is warned in-prompt; enforcement stays with the approval flow and the shell
 * ACL sandbox.
 */
export async function escapesWorkspace(workspace: string, requested: string): Promise<boolean> {
  const lexicalRoot = resolve(workspace);
  const target = resolve(requested);
  if (!inside(lexicalRoot, target)) return true;
  let cursor = target;
  while (true) {
    try {
      await lstat(cursor);
      break;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return true;
      cursor = parent;
    }
  }
  try {
    const root = await realpath(workspace);
    const realParent = await realpath(cursor);
    return !inside(root, realParent);
  } catch {
    return true;
  }
}

/** In-process path fence for workspace file access (artifact downloads). Process confinement is separate. */
export async function assertSafePath(workspace: string, requested: string) {
  if (isAbsolute(requested)) throw new Error("Path must be workspace-relative");
  const lexical = resolve(workspace, requested);
  if (!inside(workspace, lexical)) throw new Error(`Path escapes workspace: ${requested}`);
  let cursor = lexical;
  while (true) {
    try {
      await lstat(cursor);
      break;
    } catch {
      const parent = resolve(cursor, "..");
      if (parent === cursor) throw new Error("No existing parent for path");
      cursor = parent;
    }
  }
  const realRoot = await realpath(workspace);
  const realParent = await realpath(cursor);
  if (!inside(realRoot, realParent)) throw new Error(`Path resolves outside workspace: ${requested}`);
  return lexical;
}
