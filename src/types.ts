import { z } from "zod";

export const PermissionMode = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const ModelProfile = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  protocol: z
    .enum(["responses", "chat-completions"])
    .default("chat-completions"),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  reasoningEffort: z
    .enum(["none", "low", "medium", "high", "xhigh"])
    .optional(),
  maxOutputTokens: z.number().int().positive().default(8192),
  // Display-only: denominator of the web context-usage ring; not enforced by the loop.
  contextBudget: z.number().int().positive().default(120000),
});
export type ModelProfile = z.infer<typeof ModelProfile>;

export const TaskDefinition = z.object({
  id: z.string().optional(),
  sessionId: z.string().optional(),
  prompt: z.string().min(1),
  workspace: z.string().min(1),
  modelProfile: ModelProfile,
  setup: z.array(z.string()).default([]),
  grader: z.array(z.string()).default([]),
  timeout: z.number().int().positive().default(1_800_000),
  toolTimeout: z.number().int().positive().default(300_000),
  permissionMode: PermissionMode.default("workspace-write"),
  network: z.boolean().default(true),
  maxTurns: z.number().int().positive().default(100),
  variant: z.string().default("default"),
});
export type TaskDefinition = z.infer<typeof TaskDefinition>;

export type ToolName = "pwsh" | "str_replace_editor";
export interface ToolCall {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
}
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}
export interface ModelTurn {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  usage: Usage;
  raw: unknown;
}
export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: ToolName;
  toolCalls?: ToolCall[];
};

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
export interface RunRecord {
  id: string;
  status: RunStatus;
  task: TaskDefinition;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
}
export interface TraceEvent {
  seq: number;
  runId: string;
  at: string;
  type: string;
  data: Record<string, unknown>;
}
