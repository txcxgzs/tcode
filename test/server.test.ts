import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../src/server.js';
import { TaskDefinition, type RunRecord } from '../src/types.js';

let root = '';
let built: Awaited<ReturnType<typeof buildServer>> | undefined;

afterEach(async () => {
  if (built) {
    await built.app.close();
    built.store.close();
    built = undefined;
  }
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'tcode-server-'));
  const workspace = join(root, 'workspace');
  const staticDir = join(root, 'static');
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(staticDir, { recursive: true }),
  ]);
  built = await buildServer({ dataDir: join(root, 'data'), staticDir });
  const task = TaskDefinition.parse({
    prompt: 'test',
    workspace,
    modelProfile: { baseUrl: 'https://example.test/v1', model: 'mock', protocol: 'chat-completions' },
    permissionMode: 'workspace-write',
    network: true,
  });
  const now = new Date().toISOString();
  const run: RunRecord = { id: 'run-fixture', status: 'completed', task, createdAt: now, updatedAt: now };
  built.store.createRun(run);
  return { workspace, run };
}

describe('run interaction routes', () => {
  it('soft-archives sessions, restores them, and preserves their run trace', async () => {
    const { workspace, run } = await fixture();
    const session = built!.store.createSession({ id: 'session-archive', workspacePath: workspace, title: 'Keep me', permissionMode: 'workspace-write' });
    await built!.store.append(run.id, 'model_response', { content: 'preserved' });
    const archived = await built!.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/archive` });
    expect(archived.statusCode).toBe(200);
    expect((await built!.app.inject({ method: 'GET', url: '/api/sessions' })).json()).toHaveLength(0);
    expect((await built!.app.inject({ method: 'GET', url: '/api/sessions?archived=1' })).json()).toEqual([expect.objectContaining({ id: session.id })]);
    expect(built!.store.events(run.id)).toEqual([expect.objectContaining({ data: { content: 'preserved' } })]);
    const restored = await built!.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/restore` });
    expect(restored.statusCode).toBe(200);
    expect((await built!.app.inject({ method: 'GET', url: '/api/sessions' })).json()).toEqual([expect.objectContaining({ id: session.id })]);
  });

  it('permanently deletes only selected archived sessions and their linked runs', async () => {
    const { workspace, run } = await fixture();
    const first = built!.store.createSession({ id: 'archive-first', workspacePath: workspace, title: 'First', permissionMode: 'workspace-write' });
    const second = built!.store.createSession({ id: 'archive-second', workspacePath: workspace, title: 'Second', permissionMode: 'workspace-write' });
    const linked: RunRecord = { ...run, id: 'run-linked', task: { ...run.task, sessionId: first.id } };
    built!.store.createRun(linked);
    await built!.store.append(linked.id, 'model_response', { content: 'delete me' });
    built!.store.archiveSession(first.id);
    built!.store.archiveSession(second.id);

    const deleted = await built!.app.inject({ method: 'DELETE', url: '/api/sessions/archived', payload: { ids: [first.id] } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, sessions: 1, runs: 1 });
    expect(built!.store.getSession(first.id)).toBeUndefined();
    expect(built!.store.getRun(linked.id)).toBeUndefined();
    expect(built!.store.getSession(second.id)).toBeDefined();

    const active = built!.store.createSession({ id: 'active-session', workspacePath: workspace, title: 'Active', permissionMode: 'workspace-write' });
    const rejected = await built!.app.inject({ method: 'DELETE', url: '/api/sessions/archived', payload: { ids: [active.id] } });
    expect(rejected.statusCode).toBe(400);
    expect(built!.store.getSession(active.id)).toBeDefined();
  });

  it('exports the append-only trace as downloadable JSONL', async () => {
    const { run } = await fixture();
    await built!.store.append(run.id, 'user_message', { content: 'hello' });
    await built!.store.append(run.id, 'model_response', { content: 'world' });
    const response = await built!.app.inject({ method: 'GET', url: `/api/runs/${run.id}/export` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toContain(`${run.id}.jsonl`);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    const lines = response.body.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(['user_message', 'model_response']);
  });

  it('exports an empty trace for runs that failed before their first event', async () => {
    const { run } = await fixture();
    // No events were ever appended, so no trace file exists on disk.
    const response = await built!.app.inject({ method: 'GET', url: `/api/runs/${run.id}/export` });
    expect(response.statusCode).toBe(200);
    expect(response.body.trim()).toBe('');
  });

  it('downloads a workspace artifact and rejects path traversal', async () => {
    const { workspace, run } = await fixture();
    await writeFile(join(workspace, 'result.txt'), 'verified artifact', 'utf8');
    const valid = await built!.app.inject({ method: 'GET', url: `/api/runs/${run.id}/artifact?path=result.txt` });
    expect(valid.statusCode).toBe(200);
    expect(valid.body).toBe('verified artifact');
    expect(valid.headers['content-disposition']).toContain('result.txt');
    const traversal = await built!.app.inject({ method: 'GET', url: `/api/runs/${run.id}/artifact?path=../outside.txt` });
    expect(traversal.statusCode).toBe(400);
  });

  it('downloads artifacts addressed by absolute workspace paths', async () => {
    const { workspace, run } = await fixture();
    await writeFile(join(workspace, 'abs.txt'), 'absolute path artifact', 'utf8');
    // Tool calls record absolute paths; the endpoint relativizes them.
    const inside = await built!.app.inject({ method: 'GET', url: `/api/runs/${run.id}/artifact?path=${encodeURIComponent(join(workspace, 'abs.txt'))}` });
    expect(inside.statusCode).toBe(200);
    expect(inside.body).toBe('absolute path artifact');
    const outside = await built!.app.inject({ method: 'GET', url: `/api/runs/${run.id}/artifact?path=${encodeURIComponent(join(root, 'escape.txt'))}` });
    expect(outside.statusCode).toBe(400);
  });

  it('persists feedback only for a real model response', async () => {
    const { run } = await fixture();
    const responseEvent = await built!.store.append(run.id, 'model_response', { content: 'done' });
    const accepted = await built!.app.inject({ method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { seq: responseEvent.seq, rating: 'up' } });
    expect(accepted.statusCode).toBe(200);
    expect(built!.store.events(run.id).at(-1)).toEqual(expect.objectContaining({ type: 'message_feedback', data: { seq: responseEvent.seq, rating: 'up' } }));
    const rejected = await built!.app.inject({ method: 'POST', url: `/api/runs/${run.id}/feedback`, payload: { seq: 999, rating: 'down' } });
    expect(rejected.statusCode).toBe(400);
  });

  it('rejects messages for a run that is no longer active', async () => {
    const { run } = await fixture();
    const response = await built!.app.inject({ method: 'POST', url: `/api/runs/${run.id}/messages`, payload: { content: 'follow up', mode: 'queue' } });
    expect(response.statusCode).toBe(409);
  });

  it('accepts practical custom provider IDs and returns field-specific validation errors', async () => {
    await fixture();
    const valid = await built!.app.inject({
      method: 'PUT',
      url: '/api/model-profiles/acme_gateway.v2',
      payload: { name: 'Acme Gateway', baseUrl: 'https://example.test/v1', protocol: 'chat-completions', models: [{ id: 'vendor/model-alpha' }] },
    });
    expect(valid.statusCode).toBe(200);
    const invalid = await built!.app.inject({
      method: 'PUT',
      url: '/api/model-profiles/%40bad',
      payload: { name: 'Bad', baseUrl: 'https://example.test/v1', protocol: 'chat-completions', models: [{ id: 'model' }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatch(/^Invalid id:/);
  });

  it('restores prior conversation turns when continuing the same session', async () => {
    const { workspace, run } = await fixture();
    const session = built!.store.createSession({ id: 'session-history', workspacePath: workspace, title: 'Conversation', permissionMode: 'workspace-write' });
    const first: RunRecord = { ...run, id: 'run-first', task: { ...run.task, sessionId: session.id } };
    const second: RunRecord = { ...run, id: 'run-second', task: { ...run.task, sessionId: session.id } };
    built!.store.createRun(first);
    built!.store.createRun(second);
    await built!.store.append(first.id, 'user_message', { content: 'My favorite color is blue.' });
    await built!.store.append(first.id, 'model_response', { content: 'Understood.', toolCalls: [] });
    await built!.store.append(second.id, 'user_message', { content: 'What is my favorite color?' });
    await built!.store.append(second.id, 'model_response', { content: 'Blue.', toolCalls: [] });

    const history = built!.store.listRuns({ sessionId: session.id }).map((item) => item.id);
    expect(history).toEqual(['run-first', 'run-second']);
    const messages = history.flatMap((id) => built!.store.events(id).flatMap((event) => {
      if (event.type === 'user_message') return [{ role: 'user', content: event.data.content }];
      if (event.type === 'model_response') return [{ role: 'assistant', content: event.data.content }];
      return [];
    }));
    expect(messages.at(-2)).toEqual({ role: 'user', content: 'What is my favorite color?' });
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'Blue.' });
  });
  it('rejects a credential paired with a different provider endpoint or model', async () => {
    const { run } = await fixture();
    built!.store.upsertModelProfile({ id: 'provider-a', name: 'Provider A', baseUrl: 'https://provider-a.test/v1', protocol: 'chat-completions', models: [{ id: 'model-a' }] });
    built!.credentials.set('provider-a', 'sk-test-only-provider-a');
    const response = await built!.app.inject({ method: 'POST', url: '/api/runs', payload: { task: run.task, credentialId: 'provider-a' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/must belong to the same configured provider/);
  });
});

