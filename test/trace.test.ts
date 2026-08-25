import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { redact, TraceStore } from '../src/trace.js';

let root = ''; afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
describe('TraceStore', () => {
  it('redacts secrets in nested data and JSONL', async () => {
    root = await mkdtemp(join(tmpdir(), 'tcode-trace-')); const store = await TraceStore.create(root);
    const now = new Date().toISOString(); store.createRun({ id: 'r1', status: 'queued', createdAt: now, updatedAt: now, task: { apiKey: 'sk-this-is-a-test-secret' } as any });
    await store.append('r1', 'event', { authorization: 'Bearer secret-value', nested: { api_key: 'sk-another-test-secret' } });
    const raw = await readFile(join(root, 'runs', 'r1.jsonl'), 'utf8'); expect(raw).not.toContain('secret-value'); expect(raw).not.toContain('sk-another'); expect(raw).toContain('[REDACTED]'); store.close();
    expect(redact('Bearer abc')).toBe('[REDACTED]');
  });
});
