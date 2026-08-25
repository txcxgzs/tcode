import { describe, expect, it } from 'vitest';
import { CredentialVault, validateApiKey } from '../src/credentials.js';

describe('write-only credentials', () => {
  it('persists encrypted credentials without exposing the key', () => {
    let stored: { key: string; envelope: string } | undefined;
    const persist = {
      load: () => stored,
      save: (key: string, envelope: string) => { stored = { key, envelope }; },
      clear: () => { stored = undefined; },
    };
    const first = new CredentialVault(persist);
    first.set('deepseek', 'sk-test-123');
    expect(stored?.key).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(stored)).not.toContain('sk-test');

    const second = new CredentialVault(persist);
    expect(second.get('deepseek')).toBe('sk-test-123');
    expect(second.list()).toEqual([{ id: 'deepseek', configured: true, source: 'runtime', writable: true }]);
  });

  it('never exposes the stored value in descriptors', () => {
    const vault = new CredentialVault(); vault.set('deepseek', 'sk-test-123');
    expect(vault.describe('deepseek')).toEqual({ id: 'deepseek', configured: true, source: 'runtime', writable: true });
    expect(JSON.stringify(vault.list())).not.toContain('sk-test');
  });
  it.each(['', ' abc', 'abc ', 'DEEPSEEK_API_KEY=abc', '"abc"', '中'])('rejects malformed keys: %s', (value) => expect(() => validateApiKey(value)).toThrow());
});
