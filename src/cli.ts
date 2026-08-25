#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';
import { startServer } from './server.js';
import { loadManifest, loadTask } from './task-loader.js';
import { TraceStore } from './trace.js';
import { RunManager } from './runner.js';

const args = process.argv.slice(2); const command = args[0] ?? 'serve';
function flag(name: string, fallback?: string) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; }
// Unattended approval default is fail-closed; --yes opts into auto-allowing
// every approval prompt for non-interactive batch runs.
const autoApprove = args.includes('--yes') || args.includes('-y');
const sleep = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function waitFor(manager: RunManager, id: string, interactive: boolean) {
  const rl = interactive && !autoApprove ? createInterface({ input, output }) : undefined;
  try {
    while (true) {
      for (const approval of manager.approvals.list(id)) {
        if (rl) {
          const answer = await rl.question(`\nApproval required: ${approval.reasons.join(', ')}\n${approval.input}\nAllow once? [y/N] `);
          manager.approvals.resolve(approval.id, /^y(es)?$/i.test(answer.trim()));
        } else manager.approvals.resolve(approval.id, autoApprove);
      }
      const run = manager.store.getRun(id)!; if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
      await sleep(200);
    }
  } finally { rl?.close(); }
}

async function main() {
  if (command === 'serve') { const port = Number(flag('--port', '3080')); const host = flag('--host', '127.0.0.1')!; const dataDir = resolve(flag('--data', '.tcode')!); await startServer({ port, host, dataDir }); console.log(`TCode listening on http://${host}:${port}`); return; }
  const dataDir = resolve(flag('--data', '.tcode')!); const store = await TraceStore.create(dataDir); const manager = new RunManager(store);
  if (command === 'replay') { const events = await store.replay(args[1]); for (const event of events) console.log(JSON.stringify(event)); return; }
  const apiKey = process.env.TCODE_API_KEY ?? process.env.OPENAI_API_KEY; if (!apiKey) throw new Error('Set TCODE_API_KEY or OPENAI_API_KEY in the process environment');
  if (command === 'run') { const task = await loadTask(args[1]); const run = manager.start(task, apiKey); console.log(`Run ${run.id}`); const done = await waitFor(manager, run.id, true); console.log(JSON.stringify(done, null, 2)); process.exitCode = done.status === 'completed' ? 0 : 1; return; }
  if (command === 'batch') { const tasks = await loadManifest(args[1]); const results = []; for (const task of tasks) { const run = manager.start(task, apiKey); results.push(await waitFor(manager, run.id, false)); } console.log(JSON.stringify(results, null, 2)); process.exitCode = results.every((run) => run.status === 'completed') ? 0 : 1; return; }
  throw new Error('Usage: tcode serve [--port 3080] [--data .tcode] | run <task> [--yes] | batch <manifest> [--yes] | replay <run-id>');
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
