import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import YAML from 'yaml';
import { TaskDefinition, type TaskDefinition as Task } from './types.js';

export async function loadDocument(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  return ['.yaml', '.yml'].includes(extname(path).toLowerCase()) ? YAML.parse(text) : JSON.parse(text);
}

export async function loadTask(path: string): Promise<Task> {
  const raw = await loadDocument(path) as any;
  if (raw.workspace) raw.workspace = resolve(raw.workspace);
  return TaskDefinition.parse(raw);
}

export async function loadManifest(path: string): Promise<Task[]> {
  const raw = await loadDocument(path) as any;
  const tasks = Array.isArray(raw) ? raw : raw.tasks;
  if (!Array.isArray(tasks)) throw new Error('Manifest must be an array or contain a tasks array');
  return tasks.map((task) => TaskDefinition.parse({ ...task, workspace: resolve(task.workspace) }));
}
