import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AddressInfo } from 'node:net';
import { TraceStore } from '../src/trace.js';
import { RunManager } from '../src/runner.js';
import { SYSTEM_PROMPT } from '../src/system-prompt.js';
import { TaskDefinition } from '../src/types.js';

let root = '', server: Server | undefined, store: TraceStore | undefined, approver: ReturnType<typeof setInterval> | undefined;
afterEach(async () => { if (approver) clearInterval(approver); server?.close(); store?.close(); if (root) await rm(root, { recursive: true, force: true }); });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// workspace-write maps to approvalPolicy 'ask'; tests auto-allow every request.
function autoApprove(manager: RunManager, runId: string) {
  approver = setInterval(() => {
    for (const approval of manager.approvals.list(runId)) manager.approvals.resolve(approval.id, true);
  }, 20);
}

describe.runIf(process.platform === 'win32')('HarnessRun', () => {
  it('executes a two-tool-compatible agent loop and grades the result', async () => {
    root = await mkdtemp(join(tmpdir(), 'tcode-runner-')); let calls = 0;
    server = createServer((request, response) => {
      let body = ''; request.on('data', (chunk) => body += chunk); request.on('end', () => {
        calls++; const parsed = JSON.parse(body); expect(parsed.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT }); expect(parsed.tools).toHaveLength(2); expect(parsed.tools.map((x: any) => x.function.name)).toEqual(['pwsh', 'str_replace_editor']);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (calls === 1) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'str_replace_editor', arguments: JSON.stringify({ command: 'create', path: join(root, 'result.txt'), file_text: 'done\n' }) } }] } }] })}\r\n\r\n`);
        } else response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Completed and verified.' } }] })}\r\n\r\n`);
        response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\r\n\r\ndata: [DONE]\r\n\r\n`); response.end();
      });
    }); await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve)); const port = (server.address() as AddressInfo).port;
    store = await TraceStore.create(join(root, '.data')); const manager = new RunManager(store);
    const task = TaskDefinition.parse({ prompt: 'Create result.txt', workspace: root, modelProfile: { baseUrl: `http://127.0.0.1:${port}`, model: 'mock', protocol: 'chat-completions' }, grader: ["if (!(Test-Path result.txt)) { throw 'missing' }"], permissionMode: 'workspace-write', network: true });
    const record = manager.start(task, 'sk-test-never-persist');
    autoApprove(manager, record.id);
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(store.getRun(record.id)!.status); i++) await wait(50);
    expect(store.getRun(record.id)!.status).toBe('completed'); expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('done\n');
    const jsonl = await readFile(join(root, '.data', 'runs', `${record.id}.jsonl`), 'utf8'); expect(jsonl).not.toContain('sk-test-never-persist'); expect(store.events(record.id).some((event) => event.type === 'grader')).toBe(true);
  });

  it('queues a user message until a response would otherwise finish the run', async () => {
    root = await mkdtemp(join(tmpdir(), 'tcode-queue-'));
    let releaseFirst!: () => void;
    let firstRequest!: () => void;
    const requested = new Promise<void>((resolve) => firstRequest = resolve);
    const released = new Promise<void>((resolve) => releaseFirst = resolve);
    const bodies: any[] = [];
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => raw += chunk);
      request.on('end', async () => {
        bodies.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (bodies.length === 1) {
          firstRequest();
          await released;
          response.write('data: {"choices":[{"delta":{"content":"first answer"}}]}\r\n\r\n');
        } else {
          response.write('data: {"choices":[{"delta":{"content":"queued answer"}}]}\r\n\r\n');
        }
        response.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\r\n\r\ndata: [DONE]\r\n\r\n');
        response.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    store = await TraceStore.create(join(root, '.data'));
    const manager = new RunManager(store);
    const task = TaskDefinition.parse({ prompt: 'initial', workspace: root, modelProfile: { baseUrl: `http://127.0.0.1:${port}`, model: 'mock', protocol: 'chat-completions' }, permissionMode: 'workspace-write', network: true });
    const record = manager.start(task, 'sk-test-only');
    await requested;
    expect(manager.enqueueMessage(record.id, 'follow-up queued', 'queue')).toBe(true);
    releaseFirst();
    for (let i = 0; i < 100 && store.getRun(record.id)!.status !== 'completed'; i++) await wait(30);
    expect(store.getRun(record.id)!.status).toBe('completed');
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages).toContainEqual(expect.objectContaining({ role: 'user', content: 'follow-up queued' }));
    expect(store.events(record.id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'user_message', data: expect.objectContaining({ mode: 'queue' }) })]));
  });

  it('injects a steering message before the next model turn', async () => {
    root = await mkdtemp(join(tmpdir(), 'tcode-steer-'));
    let releaseFirst!: () => void;
    let firstRequest!: () => void;
    const requested = new Promise<void>((resolve) => firstRequest = resolve);
    const released = new Promise<void>((resolve) => releaseFirst = resolve);
    const bodies: any[] = [];
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => raw += chunk);
      request.on('end', async () => {
        bodies.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (bodies.length === 1) {
          firstRequest();
          await released;
          const call = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_steer', function: { name: 'str_replace_editor', arguments: JSON.stringify({ command: 'create', path: join(root, 'steered.txt'), file_text: 'ok\n' }) } }] } }] };
          response.write(`data: ${JSON.stringify(call)}\r\n\r\n`);
        } else {
          response.write('data: {"choices":[{"delta":{"content":"steered answer"}}]}\r\n\r\n');
        }
        response.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\r\n\r\ndata: [DONE]\r\n\r\n');
        response.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    store = await TraceStore.create(join(root, '.data'));
    const manager = new RunManager(store);
    const task = TaskDefinition.parse({ prompt: 'initial', workspace: root, modelProfile: { baseUrl: `http://127.0.0.1:${port}`, model: 'mock', protocol: 'chat-completions' }, permissionMode: 'workspace-write', network: true });
    const record = manager.start(task, 'sk-test-only');
    autoApprove(manager, record.id);
    await requested;
    expect(manager.enqueueMessage(record.id, 'change direction now', 'steer')).toBe(true);
    releaseFirst();
    for (let i = 0; i < 100 && store.getRun(record.id)!.status !== 'completed'; i++) await wait(30);
    expect(store.getRun(record.id)!.status).toBe('completed');
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages).toContainEqual(expect.objectContaining({ role: 'user', content: 'change direction now' }));
    expect(store.events(record.id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'user_message', data: expect.objectContaining({ mode: 'steer' }) })]));
  });

  it('fails the run record instead of hanging when the workspace is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'tcode-runner-missing-'));
    store = await TraceStore.create(join(root, '.data'));
    const manager = new RunManager(store);
    const task = TaskDefinition.parse({ prompt: 'unreachable', workspace: join(root, 'does-not-exist'), modelProfile: { baseUrl: 'http://127.0.0.1:9', model: 'mock', protocol: 'chat-completions' }, permissionMode: 'workspace-write', network: true });
    const record = manager.start(task, 'sk-test-only');
    for (let i = 0; i < 100 && !['completed', 'failed', 'cancelled'].includes(store.getRun(record.id)!.status); i++) await wait(20);
    expect(store.getRun(record.id)!.status).toBe('failed');
    expect(store.getRun(record.id)!.error).toMatch(/does-not-exist/);
  });

  it('denies out-of-workspace paths outright in workspace-write mode', async () => {
    root = await mkdtemp(join(tmpdir(), 'tcode-runner-fence-'));
    const outside = await mkdtemp(join(tmpdir(), 'tcode-runner-fence-out-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(outside, 'readme.txt'), 'external content\n');
    const bodies: any[] = [];
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => raw += chunk);
      request.on('end', () => {
        bodies.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (bodies.length === 1) {
          const call = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_fence', function: { name: 'str_replace_editor', arguments: JSON.stringify({ command: 'view', path: join(outside, 'readme.txt') }) } }] } }] };
          response.write(`data: ${JSON.stringify(call)}\r\n\r\n`);
        } else {
          response.write('data: {"choices":[{"delta":{"content":"done"}}]}\r\n\r\n');
        }
        response.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\r\n\r\ndata: [DONE]\r\n\r\n');
        response.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    store = await TraceStore.create(join(root, '.data'));
    const manager = new RunManager(store);
    const task = TaskDefinition.parse({ prompt: 'read the external file', workspace: root, modelProfile: { baseUrl: `http://127.0.0.1:${port}`, model: 'mock', protocol: 'chat-completions' }, permissionMode: 'workspace-write', network: true });
    const record = manager.start(task, 'sk-test-only');
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(store.getRun(record.id)!.status); i++) await wait(30);
    expect(store.getRun(record.id)!.status).toBe('completed');
    const events = store.events(record.id);
    expect(events.some((event) => event.type === 'boundary_warning')).toBe(false);
    expect(events.some((event) => event.type.startsWith('approval_'))).toBe(false);
    expect(String(events.find((event) => event.type === 'tool_result')?.data.output)).toContain('Denied');
    expect(String(events.find((event) => event.type === 'tool_result')?.data.output)).toContain('outside the workspace');
  });

  it('warns in-prompt on boundary crossings under full access, without blocking', async () => {
    root = await mkdtemp(join(tmpdir(), 'tcode-runner-full-'));
    const outside = await mkdtemp(join(tmpdir(), 'tcode-runner-full-out-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(outside, 'readme.txt'), 'external content\n');
    const bodies: any[] = [];
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => raw += chunk);
      request.on('end', () => {
        bodies.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (bodies.length === 1) {
          const call = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_fence', function: { name: 'str_replace_editor', arguments: JSON.stringify({ command: 'view', path: join(outside, 'readme.txt') }) } }] } }] };
          response.write(`data: ${JSON.stringify(call)}\r\n\r\n`);
        } else {
          response.write('data: {"choices":[{"delta":{"content":"done"}}]}\r\n\r\n');
        }
        response.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\r\n\r\ndata: [DONE]\r\n\r\n');
        response.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    store = await TraceStore.create(join(root, '.data'));
    const manager = new RunManager(store);
    const task = TaskDefinition.parse({ prompt: 'read the external file', workspace: root, modelProfile: { baseUrl: `http://127.0.0.1:${port}`, model: 'mock', protocol: 'chat-completions' }, permissionMode: 'danger-full-access', network: true });
    const record = manager.start(task, 'sk-test-only');
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(store.getRun(record.id)!.status); i++) await wait(30);
    expect(store.getRun(record.id)!.status).toBe('completed');
    const events = store.events(record.id);
    expect(events.some((event) => event.type === 'boundary_warning')).toBe(true);
    expect(events.some((event) => event.type.startsWith('approval_'))).toBe(false);
    expect(bodies[1].messages).toContainEqual(expect.objectContaining({ role: 'user', content: expect.stringContaining('非必要严禁越界操作') }));
    // The out-of-workspace view still executed: its tool result carries the file.
    expect(events.filter((event) => event.type === 'tool_result')[0]?.data.output).toContain('external content');
    // Executed tool results end with an injected wall-clock timing marker.
    expect(String(events.filter((event) => event.type === 'tool_result')[0]?.data.output)).toMatch(/\[time: \d+\.\d{2}s\]$/);
  });

  it('approves out-of-workspace writes one at a time with a danger-flagged request', async () => {
    root = await mkdtemp(join(tmpdir(), 'tcode-runner-boundary-'));
    const outsideA = join(root, '..', 'tcode-boundary-a-' + Date.now());
    const outsideB = join(root, '..', 'tcode-boundary-b-' + Date.now());
    const bodies: any[] = [];
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => raw += chunk);
      request.on('end', () => {
        bodies.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (bodies.length <= 2) {
          const target = bodies.length === 1 ? outsideA : outsideB;
          const call = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_bw_' + bodies.length, function: { name: 'str_replace_editor', arguments: JSON.stringify({ command: 'create', path: target, file_text: 'out\n' }) } }] } }] };
          response.write(`data: ${JSON.stringify(call)}\r\n\r\n`);
        } else {
          response.write('data: {"choices":[{"delta":{"content":"done"}}]}\r\n\r\n');
        }
        response.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\r\n\r\ndata: [DONE]\r\n\r\n');
        response.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    store = await TraceStore.create(join(root, '.data'));
    const manager = new RunManager(store);
    const task = TaskDefinition.parse({ prompt: 'write outside twice', workspace: root, modelProfile: { baseUrl: `http://127.0.0.1:${port}`, model: 'mock', protocol: 'chat-completions' }, permissionMode: 'workspace-write', network: true });
    const record = manager.start(task, 'sk-test-only');
    const { access } = await import('node:fs/promises');
    // Allow the first out-of-workspace write, deny the second; every
    // out-of-workspace write must ask again.
    for (let i = 0; i < 200; i++) {
      for (const approval of manager.approvals.list(record.id))
        manager.approvals.resolve(approval.id, approval.input.includes('boundary-a'));
      if (['completed', 'failed'].includes(store.getRun(record.id)!.status)) break;
      await wait(30);
    }
    expect(store.getRun(record.id)!.status).toBe('completed');
    const events = store.events(record.id);
    const requests = events.filter((event) => event.type === 'approval_requested');
    expect(requests).toHaveLength(2);
    expect(requests.every((event) => event.data.danger === true)).toBe(true);
    expect(String(requests[0].data.reasons[0])).toBe('Out-of-workspace write');
    expect(events.some((event) => event.type === 'boundary_warning')).toBe(true);
    const results = events.filter((event) => event.type === 'tool_result').map((event) => String(event.data.output));
    expect(results[0]).toContain('New file created successfully at');
    expect(results[1]).toContain('rejected this out-of-workspace write');
    await expect(access(outsideA)).resolves.toBeUndefined();
    await expect(access(outsideB)).rejects.toThrow();
    await (await import('node:fs/promises')).rm(outsideA, { force: true });
    expect(bodies[2].messages).toContainEqual(expect.objectContaining({ role: 'user', content: expect.stringContaining('非必要严禁越界操作') }));
  });

  it('does not warn on relative paths, which fail absolute-path validation', async () => {
    root = await mkdtemp(join(tmpdir(), 'tcode-runner-rel-'));
    const bodies: any[] = [];
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => raw += chunk);
      request.on('end', () => {
        bodies.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (bodies.length === 1) {
          const call = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_rel', function: { name: 'str_replace_editor', arguments: JSON.stringify({ command: 'view', path: 'relative/file.txt' }) } }] } }] };
          response.write(`data: ${JSON.stringify(call)}\r\n\r\n`);
        } else {
          response.write('data: {"choices":[{"delta":{"content":"done"}}]}\r\n\r\n');
        }
        response.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\r\n\r\ndata: [DONE]\r\n\r\n');
        response.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    store = await TraceStore.create(join(root, '.data'));
    const manager = new RunManager(store);
    const task = TaskDefinition.parse({ prompt: 'read relative', workspace: root, modelProfile: { baseUrl: `http://127.0.0.1:${port}`, model: 'mock', protocol: 'chat-completions' }, permissionMode: 'workspace-write', network: true });
    const record = manager.start(task, 'sk-test-only');
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(store.getRun(record.id)!.status); i++) await wait(30);
    expect(store.getRun(record.id)!.status).toBe('completed');
    const events = store.events(record.id);
    expect(events.some((event) => event.type === 'boundary_warning')).toBe(false);
    expect(String(events.find((event) => event.type === 'tool_result')?.data.output)).toContain('path must be absolute');
  });
});
