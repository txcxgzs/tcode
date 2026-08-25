import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersistentPowerShell } from '../src/shell.js';

let shell: PersistentPowerShell | undefined, workspace = '';
afterEach(async () => { await shell?.close(); if (workspace) await rm(workspace, { recursive: true, force: true }); });
describe.runIf(process.platform === 'win32')('PersistentPowerShell', () => {
  it('preserves cwd and environment across calls', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'tcode-shell-')); shell = new PersistentPowerShell(workspace);
    expect((await shell.execute("$env:TCODE_TEST='kept'; New-Item -ItemType Directory sub | Out-Null; Set-Location sub", 5000)).exitCode).toBe(0);
    const result = await shell.execute("Write-Output $env:TCODE_TEST; (Get-Location).Path", 5000);
    expect(result.output).toContain('kept'); expect(result.output).toContain('sub');
  });
  it('reports non-zero exits', async () => { workspace = await mkdtemp(join(tmpdir(), 'tcode-shell-')); shell = new PersistentPowerShell(workspace); expect((await shell.execute('cmd /c exit 7', 15000)).exitCode).toBe(7); });
  it('times out, resets the process, and recovers with a fresh session', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'tcode-shell-')); shell = new PersistentPowerShell(workspace);
    const result = await shell.execute('Start-Sleep -Seconds 10', 100);
    expect(result.exitCode).toBe(124);
    expect(result.stateReset).toBe(true);
    expect(result.output).toContain('timed out');
    expect(result.output).toContain('persistent PowerShell session was reset');
    expect((await shell.execute("Write-Output 'recovered'", 5000)).output).toContain('recovered');
  });
  it('cancels, resets the process, and recovers with a fresh session', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'tcode-shell-')); shell = new PersistentPowerShell(workspace);
    const controller = new AbortController();
    const pending = shell.execute('Start-Sleep -Seconds 10', 5000, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect((await shell.execute("Write-Output 'recovered'", 5000)).output).toContain('recovered');
  });
});
