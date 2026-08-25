import { mkdir, appendFile, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunRecord, TraceEvent } from "./types.js";

const SECRET_KEYS = /^(api[-_]?key|authorization|token|secret)$/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEYS.test(key) ? "[REDACTED]" : redact(item),
      ]),
    );
  }
  if (typeof value === "string")
    return value.replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+)/gi,
      "[REDACTED]",
    );
  return value;
}

export class TraceStore {
  readonly root: string;
  private db: DatabaseSync;
  private listeners = new Map<string, Set<(event: TraceEvent) => void>>();
  // Fire-and-forget callers (model_delta streams) race awaited ones; the
  // chain keeps seq assignment and file appends strictly ordered.
  private appendChain: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
    this.db = new DatabaseSync(join(root, "runs.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, task_json TEXT NOT NULL, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(run_id, seq));
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, title TEXT NOT NULL, blank INTEGER NOT NULL DEFAULT 1, permission_mode TEXT NOT NULL DEFAULT 'workspace-write', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, protocol TEXT NOT NULL, models_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    try {
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'workspace-write'",
      );
    } catch {}
    this.db.exec(`
      UPDATE sessions SET permission_mode='workspace-write'
      WHERE permission_mode IN ('review', 'workspace-ask', 'outside-ask', 'ask-everything');
      UPDATE sessions SET permission_mode='danger-full-access'
      WHERE permission_mode='full-access';
    `);
    try {
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
      );
    } catch {}
  }

  static async create(root: string) {
    await mkdir(root, { recursive: true });
    return new TraceStore(root);
  }

  createRun(run: RunRecord) {
    const safe = redact(run.task);
    this.db
      .prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        run.id,
        run.status,
        run.createdAt,
        run.updatedAt,
        JSON.stringify(safe),
        null,
        null,
      );
  }

  updateRun(id: string, status: string, result?: string, error?: string) {
    this.db
      .prepare(
        "UPDATE runs SET status=?, updated_at=?, result=?, error=? WHERE id=?",
      )
      .run(status, new Date().toISOString(), result ?? null, error ?? null, id);
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      status: row.status,
      task: JSON.parse(row.task_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
    };
  }

  listRuns(options: { sessionId?: string } = {}): RunRecord[] {
    const rows = options.sessionId
      ? (this.db.prepare("SELECT * FROM runs WHERE json_extract(task_json, '$.sessionId')=? ORDER BY created_at ASC").all(options.sessionId) as any[])
      : (this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as any[]);
    return (
      rows
    ).map((row) => ({
      id: row.id,
      status: row.status,
      task: JSON.parse(row.task_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
    }));
  }

  listWorkspaces() {
    return (
      this.db
        .prepare("SELECT * FROM workspaces ORDER BY updated_at DESC")
        .all() as any[]
    ).map((row) => ({
      id: row.id,
      path: row.path,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  upsertWorkspace(workspace: { id: string; path: string; title: string }) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspaces (id,path,title,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at`,
      )
      .run(workspace.id, workspace.path, workspace.title, now, now);
    return this.db
      .prepare("SELECT * FROM workspaces WHERE path=?")
      .get(workspace.path) as any;
  }

  listModelProfiles() {
    return (
      this.db
        .prepare("SELECT * FROM model_profiles ORDER BY created_at")
        .all() as any[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      protocol: row.protocol,
      models: JSON.parse(row.models_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  upsertModelProfile(profile: { id: string; name: string; baseUrl: string; protocol: string; models: unknown[] }) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO model_profiles (id,name,base_url,protocol,models_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, protocol=excluded.protocol, models_json=excluded.models_json, updated_at=excluded.updated_at`)
      .run(profile.id, profile.name, profile.baseUrl, profile.protocol, JSON.stringify(profile.models), now, now);
    return this.listModelProfiles().find((item) => item.id === profile.id);
  }

  deleteModelProfile(id: string) {
    this.db.prepare("DELETE FROM model_profiles WHERE id=?").run(id);
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as any;
    return row?.value;
  }

  setSetting(key: string, value: string) {
    this.db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  deleteSetting(key: string) {
    this.db.prepare("DELETE FROM settings WHERE key=?").run(key);
  }

  listSessions(archived = false) {
    return (
      this.db
        .prepare(
          "SELECT * FROM sessions WHERE archived=? ORDER BY updated_at DESC",
        )
        .all(archived ? 1 : 0) as any[]
    ).map((row) => ({
      id: row.id,
      workspacePath: row.workspace_path,
      title: row.title,
      blank: Boolean(row.blank),
      permissionMode: row.permission_mode,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createSession(session: {
    id: string;
    workspacePath: string;
    title: string;
    permissionMode: string;
  }) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (id,workspace_path,title,blank,permission_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        session.id,
        session.workspacePath,
        session.title,
        1,
        session.permissionMode,
        now,
        now,
      );
    return { ...session, blank: true, createdAt: now, updatedAt: now };
  }

  activateSession(id: string, prompt: string) {
    this.db
      .prepare("UPDATE sessions SET title=?, blank=0, updated_at=? WHERE id=?")
      .run(prompt.split(/\r?\n/)[0].slice(0, 80), new Date().toISOString(), id);
  }

  setSessionPermission(id: string, permissionMode: string) {
    this.db
      .prepare("UPDATE sessions SET permission_mode=?, updated_at=? WHERE id=?")
      .run(permissionMode, new Date().toISOString(), id);
  }

  archiveSession(id: string) {
    this.db
      .prepare("UPDATE sessions SET archived=1, updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
  }

  restoreSession(id: string) {
    this.db
      .prepare("UPDATE sessions SET archived=0, updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
  }

  async deleteArchivedSessions(ids?: string[]) {
    const archived = this.listSessions(true);
    const requested = ids?.length ? new Set(ids) : null;
    const targets = archived.filter((session) => !requested || requested.has(session.id));
    if (requested && targets.length !== requested.size)
      throw new Error("Only archived sessions can be permanently deleted");
    if (!targets.length) return { sessions: 0, runs: 0 };

    const targetIds = new Set(targets.map((session) => session.id));
    const runIds = this.listRuns()
      .filter((run) => run.task.sessionId && targetIds.has(run.task.sessionId))
      .map((run) => run.id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const deleteEvents = this.db.prepare("DELETE FROM events WHERE run_id=?");
      const deleteRun = this.db.prepare("DELETE FROM runs WHERE id=?");
      for (const runId of runIds) {
        deleteEvents.run(runId);
        deleteRun.run(runId);
      }
      const deleteSession = this.db.prepare("DELETE FROM sessions WHERE id=? AND archived=1");
      for (const session of targets) deleteSession.run(session.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    await Promise.all(runIds.map((runId) => rm(join(this.root, "runs", `${runId}.jsonl`), { force: true })));
    return { sessions: targets.length, runs: runIds.length };
  }

  getSession(id: string) {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id=?")
      .get(id) as any;
    return row
      ? {
          id: row.id,
          workspacePath: row.workspace_path,
          title: row.title,
          blank: Boolean(row.blank),
          permissionMode: row.permission_mode,
        }
      : undefined;
  }

  async append(
    runId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<TraceEvent> {
    const task = this.appendChain.then(() => this.appendNow(runId, type, data));
    this.appendChain = task.then(() => undefined, () => undefined);
    return task;
  }

  private async appendNow(
    runId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<TraceEvent> {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE run_id=?",
      )
      .get(runId) as { seq: number };
    const event: TraceEvent = {
      seq: row.seq,
      runId,
      at: new Date().toISOString(),
      type,
      data: redact(data) as Record<string, unknown>,
    };
    this.db
      .prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
      .run(runId, event.seq, event.at, event.type, JSON.stringify(event.data));
    const path = join(this.root, "runs", `${runId}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(event) + "\n", "utf8");
    for (const listener of this.listeners.get(runId) ?? []) listener(event);
    return event;
  }

  events(runId: string): TraceEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM events WHERE run_id=? ORDER BY seq")
        .all(runId) as any[]
    ).map((row) => ({
      runId: row.run_id,
      seq: row.seq,
      at: row.at,
      type: row.type,
      data: JSON.parse(row.data_json),
    }));
  }

  subscribe(runId: string, listener: (event: TraceEvent) => void) {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(runId);
    };
  }

  async replay(runId: string) {
    const path = join(this.root, "runs", `${runId}.jsonl`);
    // Runs that failed before their first traced event have no file; an
    // empty trace is valid for them (the run record carries the failure).
    const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    return text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEvent);
  }
  close() {
    this.db.close();
  }
}

