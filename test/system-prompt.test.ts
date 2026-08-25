import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../src/server.js';
import { SYSTEM_PROMPT } from '../src/system-prompt.js';
import { ADHD_SKILL } from '../src/adhd-skill.js';
import { redact } from '../src/trace.js';

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
  root = await mkdtemp(join(tmpdir(), 'tcode-sysprompt-'));
  built = await buildServer({ dataDir: join(root, 'data') });
}

describe('system prompt', () => {
  it('ships the engineering principles in every mode by default', () => {
    expect(SYSTEM_PROMPT).toContain('You are a helpful software engineer assistant.');
    expect(SYSTEM_PROMPT).toContain('八荣八耻');
    expect(SYSTEM_PROMPT).toContain('以静默遗漏为耻，以主动披露为荣。');
    expect(SYSTEM_PROMPT).toContain('5. 完成必须验证并对账');
    expect(SYSTEM_PROMPT.endsWith('绝不能省略、隐藏或声称已完成。')).toBe(true);
  });

  it('serves, stores, and resets a custom system prompt', async () => {
    await fixture();
    const initial = await built!.app.inject({ method: 'GET', url: '/api/system-prompt' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ default: SYSTEM_PROMPT, custom: null, effective: SYSTEM_PROMPT });

    const saved = await built!.app.inject({ method: 'PUT', url: '/api/system-prompt', payload: { prompt: 'You are a terse coding agent.' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().effective).toBe('You are a terse coding agent.');

    const after = await built!.app.inject({ method: 'GET', url: '/api/system-prompt' });
    expect(after.json()).toEqual({ default: SYSTEM_PROMPT, custom: 'You are a terse coding agent.', effective: 'You are a terse coding agent.' });

    const reset = await built!.app.inject({ method: 'DELETE', url: '/api/system-prompt' });
    expect(reset.json().effective).toBe(SYSTEM_PROMPT);
    expect((await built!.app.inject({ method: 'GET', url: '/api/system-prompt' })).json().custom).toBeNull();
  });

  it('rejects empty and oversized prompts', async () => {
    await fixture();
    expect((await built!.app.inject({ method: 'PUT', url: '/api/system-prompt', payload: { prompt: '   ' } })).statusCode).toBe(400);
    expect((await built!.app.inject({ method: 'PUT', url: '/api/system-prompt', payload: { prompt: 'x'.repeat(20_001) } })).statusCode).toBe(400);
  });

  it('serves the embedded ADHD skill and appends it per run when requested', async () => {
    await fixture();
    const response = await built!.app.inject({ method: 'GET', url: '/api/adhd-skill' });
    expect(response.statusCode).toBe(200);
    expect(response.json().text.startsWith('# i-have-adhd')).toBe(true);
    expect(response.json().text).toContain('Lead with the next action');

    const { RunManager } = await import('../src/runner.js');
    const { TaskDefinition } = await import('../src/types.js');
    const manager = new RunManager(built!.store);
    const task = TaskDefinition.parse({
      prompt: 'adhd run',
      workspace: root,
      modelProfile: { baseUrl: 'https://example.test/v1', model: 'mock', protocol: 'chat-completions' },
      permissionMode: 'read-only',
      network: true,
    });
    const settle = async (id: string) => {
      for (let i = 0; i < 200 && !['completed', 'failed'].includes(built!.store.getRun(id)!.status); i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const startedPrompt = async (id: string) => String(built!.store.events(id).find((event) => event.type === 'run_started')?.data.systemPrompt);

    const run = manager.start(task, 'sk-test-only', { appendAdhdSkill: true });
    await settle(run.id);
    // The trace copy is redacted (Bearer ${token} in the skill text); the
    // model-facing prompt keeps the original.
    expect(await startedPrompt(run.id)).toBe(redact(`${SYSTEM_PROMPT}\n\n${ADHD_SKILL}`));

    // A stored custom prompt stays the base; the append composes on top.
    built!.store.setSetting('systemPrompt', 'custom base');
    const run2 = manager.start(task, 'sk-test-only', { appendAdhdSkill: true });
    await settle(run2.id);
    expect(await startedPrompt(run2.id)).toBe(redact(`custom base\n\n${ADHD_SKILL}`));
    const run3 = manager.start(task, 'sk-test-only');
    await settle(run3.id);
    expect(await startedPrompt(run3.id)).toBe('custom base');
  });
});
