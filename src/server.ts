import Fastify, { LogController } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isAbsolute, relative } from "node:path";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TaskDefinition } from "./types.js";
import { TraceStore } from "./trace.js";
import { RunManager } from "./runner.js";
import { CredentialVault } from "./credentials.js";
import { z } from "zod";
import { discoverModels } from "./model.js";
import { normalizePermissionMode } from "./permissions.js";
import { assertSafePath } from "./permissions.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { ADHD_SKILL } from "./adhd-skill.js";

const StoredModelProfile = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "Use 1-64 lowercase letters, numbers, dots, underscores, or hyphens"),
  name: z.string().trim().min(1).max(60),
  baseUrl: z.string().url(),
  protocol: z.enum(["chat-completions", "responses"]),
  models: z.array(z.object({
    id: z.string().trim().min(1).max(240),
    name: z.string().trim().max(120).optional(),
    contextBudget: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })).min(1),
});

export interface ServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  staticDir?: string;
}

function selectWindowsDirectory(): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  // FolderBrowserDialog.ShowDialog() with no parent window may not appear
  // when launched from a background Node process. Create a tiny invisible
  // form, call Show() to create its window handle, then pass it as the
  // parent to ShowDialog so the picker is properly attached to a window.
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select a project folder'",
    "$dialog.AutoUpgradeEnabled = $true",
    "$dialog.ShowNewFolderButton = $true",
    "$form = New-Object System.Windows.Forms.Form",
    "$form.Text = 'TCode'",
    "$form.TopMost = $true",
    "$form.ShowInTaskbar = $false",
    "$form.Width = 0",
    "$form.Height = 0",
    "$form.FormBorderStyle = 'FixedToolWindow'",
    "$form.StartPosition = 'CenterScreen'",
    "$form.Show()",
    "$form.Hide()",
    "[System.Windows.Forms.Application]::DoEvents()",
    "if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "  [Console]::Write($dialog.SelectedPath)",
    "}",
    "$form.Close()",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-EncodedCommand", encoded],
      { encoding: "utf8", windowsHide: false, timeout: 5 * 60_000 },
      (error, stdout) => {
        if (error && !(error as any).killed) {
          rejectPromise(error);
          return;
        }
        const selected = stdout.trim();
        resolvePromise(selected || null);
      },
    );
  });
}

export async function buildServer(options: ServerOptions = {}) {
  const app = Fastify({
    logger: { redact: ["req.headers.authorization", "req.body.apiKey"] },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2_000_000,
  });
  const dataDir = resolve(options.dataDir ?? ".tcode");
  const store = await TraceStore.create(dataDir);
  const manager = new RunManager(store);
  const credentials = new CredentialVault({
    load: () => {
      const key = store.getSetting("credentialKey");
      const envelope = store.getSetting("credentials");
      return key && envelope ? { key, envelope } : undefined;
    },
    save: (key, envelope) => {
      store.setSetting("credentialKey", key);
      store.setSetting("credentials", envelope);
    },
    clear: () => {
      store.deleteSetting("credentialKey");
      store.deleteSetting("credentials");
    },
  });
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin) return;
    try {
      if (new URL(origin).host !== request.headers.host)
        return reply
          .code(403)
          .send({ error: "Cross-origin requests are not allowed" });
    } catch {
      return reply.code(403).send({ error: "Invalid Origin header" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    version: "0.1.0",
    platform: process.platform,
  }));
  app.get("/api/workspaces", async () => store.listWorkspaces());
  app.post("/api/select-directory", async (_request, reply) => {
    if (process.platform !== "win32")
      return reply.code(501).send({ error: "Native directory selection is only available on Windows" });
    try {
      return { path: await selectWindowsDirectory() };
    } catch (error) {
      return reply.code(500).send({
        error: error instanceof Error ? error.message : "Directory selection failed",
      });
    }
  });
  app.post("/api/workspaces", async (request, reply) => {
    try {
      const input = String((request.body as any)?.path ?? "");
      const canonical = await realpath(resolve(input));
      if (!(await stat(canonical)).isDirectory())
        throw new Error("Path is not a directory");
      const requestedTitle = String((request.body as any)?.title ?? "").trim();
      if (requestedTitle.length > 80) throw new Error("Project name is too long");
      const title = requestedTitle || basename(canonical) || canonical;
      const row = store.upsertWorkspace({
        id: randomUUID(),
        path: canonical,
        title,
      });
      return {
        id: row.id,
        path: row.path,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Invalid workspace",
      });
    }
  });
  app.get("/api/model-profiles", async () => store.listModelProfiles());
  app.post("/api/model-profiles/discover", async (request, reply) => {
    const body = request.body as any;
    const parsed = z.object({
      baseUrl: z.string().url(),
      credentialId: z.string().optional(),
      apiKey: z.string().min(1).optional(),
    }).safeParse(body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid discovery request" });
    const apiKey = parsed.data.apiKey ?? (parsed.data.credentialId ? credentials.get(parsed.data.credentialId) : undefined);
    if (!apiKey) return reply.code(400).send({ error: "API key is required for model discovery" });
    try {
      const models = await discoverModels(parsed.data.baseUrl, apiKey, AbortSignal.timeout(20_000));
      return { models };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Model discovery failed" });
    }
  });
  app.put("/api/model-profiles/:id", async (request, reply) => {
    const parsed = StoredModelProfile.safeParse({ ...(request.body as any), id: (request.params as any).id });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.length ? issue.path.join(".") : "provider";
      return reply.code(400).send({ error: `Invalid ${field}: ${issue?.message ?? "invalid value"}`, issues: parsed.error.issues });
    }
    return store.upsertModelProfile(parsed.data);
  });
  app.delete("/api/model-profiles/:id", async (request) => {
    store.deleteModelProfile((request.params as any).id);
    credentials.clear((request.params as any).id);
    return { ok: true };
  });
  const SystemPromptUpdate = z.object({
    prompt: z.string().trim().min(1, "System prompt cannot be empty").max(20_000, "System prompt cannot exceed 20000 characters"),
  });
  app.get("/api/system-prompt", async () => {
    const custom = store.getSetting("systemPrompt");
    return {
      default: SYSTEM_PROMPT,
      custom: custom ?? null,
      effective: custom ?? SYSTEM_PROMPT,
    };
  });
  app.put("/api/system-prompt", async (request, reply) => {
    const parsed = SystemPromptUpdate.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid system prompt" });
    store.setSetting("systemPrompt", parsed.data.prompt);
    return { ok: true, effective: parsed.data.prompt };
  });
  app.delete("/api/system-prompt", async () => {
    store.deleteSetting("systemPrompt");
    return { ok: true, effective: SYSTEM_PROMPT };
  });
  app.get("/api/adhd-skill", async () => ({ text: ADHD_SKILL }));
  app.get("/api/sessions", async (request) =>
    store.listSessions(String((request.query as any)?.archived ?? "") === "1"),
  );
  app.post("/api/sessions", async (request, reply) => {
    const workspacePath = String((request.body as any)?.workspacePath ?? "");
    if (
      !store
        .listWorkspaces()
        .some(
          (workspace) =>
            workspace.path.toLowerCase() === workspacePath.toLowerCase(),
        )
    )
      return reply.code(400).send({ error: "Workspace not found" });
    let permissionMode;
    try {
      permissionMode = normalizePermissionMode(String((request.body as any)?.permissionMode ?? "workspace-write"));
    } catch {
      return reply.code(400).send({ error: "Invalid permission mode" });
    }
    return reply.code(201).send(
      store.createSession({
        id: randomUUID(),
        workspacePath,
        title: "New session",
        permissionMode,
      }),
    );
  });
  app.patch("/api/sessions/:id", async (request, reply) => {
    let permissionMode;
    try {
      permissionMode = normalizePermissionMode(String((request.body as any)?.permissionMode ?? ""));
    } catch {
      return reply.code(400).send({ error: "Invalid permission mode" });
    }
    store.setSessionPermission((request.params as any).id, permissionMode);
    return { ok: true };
  });
  app.post("/api/sessions/:id/archive", async (request) => {
    store.archiveSession((request.params as any).id);
    return { ok: true };
  });
  app.post("/api/sessions/:id/restore", async (request) => {
    store.restoreSession((request.params as any).id);
    return { ok: true };
  });
  app.delete("/api/sessions/archived", async (request, reply) => {
    const parsed = z.object({ ids: z.array(z.string().min(1)).max(500).optional() }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid archived-session deletion request" });
    try {
      return { ok: true, ...(await store.deleteArchivedSessions(parsed.data.ids)) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Archive deletion failed" });
    }
  });
  app.post("/api/sessions/:id/fork", async (request, reply) => {
    const source = store.getSession((request.params as any).id);
    if (!source) return reply.code(404).send({ error: "Session not found" });
    return reply
      .code(201)
      .send(
        store.createSession({
          id: randomUUID(),
          workspacePath: source.workspacePath,
          title: source.blank ? "New session" : `${source.title} (1)`,
          permissionMode: source.permissionMode,
        }),
      );
  });
  app.get("/api/credentials", async () => credentials.list());
  app.put("/api/credentials/:id", async (request, reply) => {
    try {
      return credentials.set(
        (request.params as any).id,
        (request.body as any)?.apiKey,
      );
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Invalid API key",
      });
    }
  });
  app.delete("/api/credentials/:id", async (request) =>
    credentials.clear((request.params as any).id),
  );
  app.get("/api/runs", async () => store.listRuns());
  app.get("/api/runs/:id", async (request, reply) => {
    const run = store.getRun((request.params as any).id);
    return run ?? reply.code(404).send({ error: "Run not found" });
  });
  app.get("/api/runs/:id/events", async (request, reply) => {
    const id = (request.params as any).id;
    if (!store.getRun(id))
      return reply.code(404).send({ error: "Run not found" });
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    for (const event of store.events(id))
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = store.subscribe(id, (event) =>
      response.write(`data: ${JSON.stringify(event)}\n\n`),
    );
    const heartbeat = setInterval(
      () => response.write(": keepalive\n\n"),
      15_000,
    );
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  app.get("/api/runs/:id/events.json", async (request, reply) => {
    const id = (request.params as any).id;
    if (!store.getRun(id))
      return reply.code(404).send({ error: "Run not found" });
    return store.events(id);
  });
  app.get("/api/runs/:id/export", async (request, reply) => {
    const id = (request.params as any).id;
    const events = await store.replay(id);
    reply.header("content-disposition", `attachment; filename="${id}.jsonl"`);
    reply.type("application/x-ndjson; charset=utf-8");
    return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  });
  app.get("/api/runs/:id/artifact", async (request, reply) => {
    const run = store.getRun((request.params as any).id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    try {
      const requested = String((request.query as any)?.path ?? "");
      const workspace = run.task.workspace;
      // Tool calls carry absolute paths; relativize them so the fence still
      // rejects anything resolving outside the workspace.
      const candidate = isAbsolute(requested) ? relative(workspace, resolve(requested)) : requested;
      const path = await assertSafePath(workspace, candidate);
      const info = await stat(path);
      if (!info.isFile()) throw new Error("Artifact is not a file");
      if (info.size > 20 * 1024 * 1024) throw new Error("Artifact exceeds the 20 MB download limit");
      const content = await readFile(path);
      const name = basename(path).replace(/["\r\n]/g, "_");
      reply.header("content-disposition", `attachment; filename="${name}"`);
      reply.type("application/octet-stream");
      return content;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid artifact" });
    }
  });
  app.post("/api/runs/:id/feedback", async (request, reply) => {
    const id = (request.params as any).id;
    if (!store.getRun(id)) return reply.code(404).send({ error: "Run not found" });
    const parsed = z.object({ seq: z.number().int().positive(), rating: z.enum(["up", "down"]) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid feedback" });
    if (!store.events(id).some((event) => event.seq === parsed.data.seq && event.type === "model_response"))
      return reply.code(400).send({ error: "Feedback target must be a model response" });
    await store.append(id, "message_feedback", parsed.data);
    return { ok: true };
  });
  app.get("/api/approvals", async (request) =>
    manager.approvals.list((request.query as any).runId),
  );
  app.post("/api/approvals/:id", async (request, reply) => {
    const allow = Boolean((request.body as any)?.allow);
    const remember = Boolean((request.body as any)?.remember);
    return manager.approvals.resolve((request.params as any).id, allow, remember)
      ? { ok: true }
      : reply.code(404).send({ error: "Approval not found" });
  });
  app.post("/api/runs", async (request, reply) => {
    const body = request.body as any;
    const parsed = TaskDefinition.safeParse(body?.task);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Invalid task", issues: parsed.error.issues });
    const credentialId = typeof body.credentialId === "string" ? body.credentialId : "";
    const apiKey = credentialId ? credentials.get(credentialId) : undefined;
    if (!apiKey)
      return reply
        .code(400)
        .send({ error: "Configure the model provider API key first" });
    const provider = store.listModelProfiles().find((item) => item.id === credentialId);
    const providerMatches = provider
      && provider.baseUrl.replace(/\/+$/, "") === parsed.data.modelProfile.baseUrl.replace(/\/+$/, "")
      && provider.protocol === parsed.data.modelProfile.protocol
      && provider.models.some((model: any) => model.id === parsed.data.modelProfile.model);
    if (!providerMatches)
      return reply
        .code(400)
        .send({ error: "The credential, provider URL, protocol, and model must belong to the same configured provider" });
    if (parsed.data.sessionId)
      store.activateSession(parsed.data.sessionId, parsed.data.prompt);
    return reply.code(202).send(manager.start(parsed.data, apiKey, { appendAdhdSkill: Boolean((body as any)?.adhd) }));
  });
  app.post("/api/runs/:id/cancel", async (request, reply) =>
    manager.cancel((request.params as any).id)
      ? { ok: true }
      : reply.code(409).send({ error: "Run is not active" }),
  );
  app.post("/api/runs/:id/messages", async (request, reply) => {
    const parsed = z.object({ content: z.string().trim().min(1).max(20_000), mode: z.enum(["queue", "steer"]) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid message" });
    return manager.enqueueMessage((request.params as any).id, parsed.data.content, parsed.data.mode)
      ? reply.code(202).send({ ok: true })
      : reply.code(409).send({ error: "Run is not accepting messages" });
  });

  const staticDir = resolve(
    options.staticDir ?? fileURLToPath(new URL("../dist-web", import.meta.url)),
  );
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    // Hashed asset files change on every web rebuild; a wildcard route keeps
    // them servable without restarting the server process.
    const assetsDir = join(staticDir, "assets");
    if (existsSync(assetsDir))
      await app.register(fastifyStatic, { root: assetsDir, prefix: "/assets/", decorateReply: false });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.sendFile("index.html"),
    );
  }
  return { app, store, manager, credentials };
}

export async function startServer(options: ServerOptions = {}) {
  const built = await buildServer(options);
  await built.app.listen({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 3080,
  });
  return built;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void startServer();
