import type { Message, ModelProfile, ModelTurn, ToolCall } from './types.js';
import { TOOL_DEFINITIONS } from './system-prompt.js';

export interface ModelRequestOptions { signal?: AbortSignal; onDelta?: (text: string) => void; onFirstToken?: () => void }

function endpoint(baseUrl: string, path: string) { return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`; }

export type DiscoveredModel = { id: string; name?: string };

export async function discoverModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<DiscoveredModel[]> {
  const response = await fetch(endpoint(baseUrl, 'models'), {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`Model discovery ${response.status}: ${await parseError(response, apiKey)}`);
  const body = await response.json() as any;
  const source = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const unique = new Map<string, DiscoveredModel>();
  for (const item of source) {
    const id = typeof item === 'string' ? item : String(item?.id ?? '').trim();
    if (!id || unique.has(id)) continue;
    const name = typeof item === 'object' && typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : undefined;
    unique.set(id, { id, name });
  }
  if (!unique.size) throw new Error('Model discovery returned no model IDs');
  return [...unique.values()];
}

function redactProviderError(value: string, apiKey?: string) {
  let safe = value.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+)/gi, '[REDACTED]');
  if (apiKey) safe = safe.replaceAll(apiKey, '[REDACTED]');
  return safe;
}

// Some upstream providers intermittently double-encode multi-byte UTF-8
// characters (notably emoji) in their SSE streams: the original UTF-8 bytes
// are decoded as Latin-1, then re-encoded as UTF-8. CJK text usually survives
// because it's already valid UTF-8 in the JSON, but 4-byte emoji (F0 9F..)
// become \u00f0\u009f.. sequences. Detect and repair only the affected runs
// so the fix never touches already-correct text.
function fixDoubleEncoding(str: string): string {
  if (!/[\u00c0-\u00ff][\u0080-\u00bf]/.test(str)) return str;
  let result = '';
  let i = 0;
  while (i < str.length) {
    const c = str.charCodeAt(i);
    if (c >= 0xc0 && c <= 0xf7) {
      let len: number;
      if (c >= 0xf0) len = 4;
      else if (c >= 0xe0) len = 3;
      else len = 2;
      let valid = true;
      const bytes: number[] = [c];
      for (let j = 1; j < len; j++) {
        if (i + j >= str.length) { valid = false; break; }
        const cc = str.charCodeAt(i + j);
        if (cc < 0x80 || cc > 0xbf) { valid = false; break; }
        bytes.push(cc);
      }
      if (valid) {
        try {
          const fixed = Buffer.from(bytes).toString('latin1');
          // Re-interpret the original bytes as UTF-8
          const decoded = Buffer.from(fixed, 'latin1').toString('utf8');
          if (decoded) {
            result += decoded;
            i += len;
            continue;
          }
        } catch { /* keep original on failure */ }
      }
    }
    result += str[i];
    i++;
  }
  return result;
}

async function parseError(response: Response, apiKey?: string) {
  const text = await response.text();
  try { const body = JSON.parse(text); return redactProviderError(String(body.error?.message ?? text), apiKey); }
  catch { return redactProviderError(text, apiKey); }
}

async function sse(response: Response, handler: (event: string, data: any) => void) {
  if (!response.body) throw new Error('Model response has no body');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  const handleBlock = (block: string) => {
    let event = 'message'; const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join('\n').trim();
    if (data && data !== '[DONE]') {
      let parsed: any;
      try { parsed = JSON.parse(data); }
      catch (error) { throw new Error(`Invalid SSE JSON for ${event}: ${error instanceof Error ? error.message : String(error)}`); }
      handler(event, parsed);
    }
  };
  while (true) {
    const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      handleBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleBlock(buffer);
}

function chatToolCalls(source: any[]): ToolCall[] {
  return (source ?? []).map((call: any, index: number) => {
    let parsed: any = {};
    try { parsed = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function?.arguments ?? {}; }
    catch (error) { throw new Error(`Invalid tool arguments for ${call.function?.name ?? index}: ${error instanceof Error ? error.message : String(error)}`); }
    const name = call.function?.name;
    if (name !== 'pwsh' && name !== 'str_replace_editor') throw new Error(`Unknown model tool: ${String(name)}`);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Tool ${name} arguments must be an object`);
    if (name === 'pwsh' && typeof parsed.command !== 'string') throw new Error('Tool pwsh command must be a string');
    if (name === 'str_replace_editor' && (typeof parsed.command !== 'string' || typeof parsed.path !== 'string')) throw new Error('Tool str_replace_editor requires command and path');
    return { id: call.id || `call_${index}`, name, input: parsed };
  });
}

function responsesInput(messages: Message[]) {
  const input: any[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content || '(no output)' });
      continue;
    }
    if (message.content) input.push({ role: message.role, content: message.content });
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) });
  }
  return input;
}

export class OpenAICompatibleModel {
  constructor(private profile: ModelProfile, private apiKey: string) {}

  async complete(messages: Message[], options: ModelRequestOptions = {}): Promise<ModelTurn> {
    return this.profile.protocol === 'responses' ? this.responses(messages, options) : this.chat(messages, options);
  }

  private async chat(messages: Message[], options: ModelRequestOptions): Promise<ModelTurn> {
    const body: any = {
      model: this.profile.model, stream: true, stream_options: { include_usage: true },
      messages: messages.map((message) => {
        if (message.role === 'assistant' && message.toolCalls?.length) return { role: 'assistant', content: message.content || null, tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) };
        // Some providers reject empty tool content; DSH's DeepSeek adapter
        // substitutes a placeholder for empty tool results.
        if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content || '(no output)' };
        return { role: message.role, content: message.content };
      }),
      max_tokens: this.profile.maxOutputTokens
    };
    body.tools = Object.entries(TOOL_DEFINITIONS).map(([name, tool]) => ({ type: 'function', function: { name, description: tool.description, parameters: tool.parameters } }));
    if (this.profile.temperature !== undefined) body.temperature = this.profile.temperature;
    if (this.profile.topP !== undefined) body.top_p = this.profile.topP;
    if (this.profile.reasoningEffort !== undefined) body.reasoning_effort = this.profile.reasoningEffort;
    const request = (payload: any) => fetch(endpoint(this.profile.baseUrl, 'chat/completions'), { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: options.signal });
    let response = await request(body);
    if (!response.ok) {
      const message = await parseError(response, this.apiKey);
      if (response.status === 400 && /stream[_ -]?options/i.test(message)) { delete body.stream_options; response = await request(body); }
      else throw new Error(`Model API ${response.status}: ${message}`);
    }
    if (!response.ok) throw new Error(`Model API ${response.status}: ${await parseError(response, this.apiKey)}`);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const data: any = await response.json();
      // Some providers (e.g. OpenRouter shared pool) return HTTP 200 with an
      // `error` field in the body and zero completion tokens when the upstream
      // model is rate-limited. Treat that as a failure rather than a silent
      // empty turn, so the runner surfaces the error instead of "succeeding"
      // with an empty answer.
      if (data?.error) throw new Error(`Model API error: ${redactProviderError(String(data.error.message ?? data.error.code ?? JSON.stringify(data.error)), this.apiKey)}`);
      const message = data.choices?.[0]?.message ?? {};
      const fixedContent = message.content ? fixDoubleEncoding(message.content) : '';
      options.onFirstToken?.();
      if (fixedContent) options.onDelta?.(fixedContent);
      return { content: fixedContent, reasoning: message.reasoning_content ?? '', toolCalls: chatToolCalls(message.tool_calls), usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens, totalTokens: data.usage?.total_tokens, cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens }, raw: data };
    }
    let content = '', reasoning = '', sawFirstToken = false; const calls = new Map<number, { id: string; name: string; args: string }>(); let usage: any = {}; const raw: unknown[] = [];
    await sse(response, (_event, data) => { raw.push(data); if (data?.error) throw new Error(`Model API error: ${redactProviderError(String(data.error.message ?? data.error.code ?? JSON.stringify(data.error)), this.apiKey)}`); usage = data.usage ?? usage; const delta = data.choices?.[0]?.delta ?? {}; if (!sawFirstToken && (delta.content || delta.reasoning_content || delta.tool_calls?.length)) { sawFirstToken = true; options.onFirstToken?.(); } if (delta.content) { const fixed = fixDoubleEncoding(delta.content); content += fixed; options.onDelta?.(fixed); } if (delta.reasoning_content) reasoning += delta.reasoning_content; for (const part of delta.tool_calls ?? []) { const call = calls.get(part.index) ?? { id: '', name: '', args: '' }; if (part.id && part.id !== call.id) call.id += part.id; call.name += part.function?.name ?? ''; call.args += part.function?.arguments ?? ''; calls.set(part.index, call); } });
    const toolCalls = chatToolCalls([...calls.values()].map((call) => ({ id: call.id, function: { name: call.name, arguments: call.args } })));
    return { content, reasoning, toolCalls, usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens, cachedInputTokens: usage.prompt_tokens_details?.cached_tokens }, raw };
  }

  private async responses(messages: Message[], options: ModelRequestOptions): Promise<ModelTurn> {
    const body: any = {
      model: this.profile.model, stream: true, max_output_tokens: this.profile.maxOutputTokens,
      input: responsesInput(messages),
    };
    body.tools = Object.entries(TOOL_DEFINITIONS).map(([name, tool]) => ({ type: 'function', name, description: tool.description, parameters: tool.parameters, strict: false }));
    if (this.profile.temperature !== undefined) body.temperature = this.profile.temperature;
    if (this.profile.topP !== undefined) body.top_p = this.profile.topP;
    if (this.profile.reasoningEffort !== undefined) body.reasoning = { effort: this.profile.reasoningEffort };
    const response = await fetch(endpoint(this.profile.baseUrl, 'responses'), { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: options.signal });
    if (!response.ok) throw new Error(`Model API ${response.status}: ${await parseError(response, this.apiKey)}`);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const data: any = await response.json();
      if (data?.error) throw new Error(`Model API error: ${redactProviderError(String(data.error.message ?? data.error.code ?? JSON.stringify(data.error)), this.apiKey)}`);
      let content = '', reasoning = ''; const toolCalls: ToolCall[] = [];
      for (const item of data.output ?? []) {
        if (item.type === 'function_call') toolCalls.push(...chatToolCalls([{ id: item.call_id, function: { name: item.name, arguments: item.arguments } }]));
        if (item.type === 'message') for (const part of item.content ?? []) if (part.type === 'output_text') content += fixDoubleEncoding(part.text ?? '');
        if (item.type === 'reasoning') for (const part of item.summary ?? []) reasoning += part.text ?? '';
      }
      options.onFirstToken?.();
      if (content) options.onDelta?.(content);
      return { content, reasoning, toolCalls, usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens, totalTokens: data.usage?.total_tokens, cachedInputTokens: data.usage?.input_tokens_details?.cached_tokens }, raw: data };
    }
    let content = '', reasoning = '', completed: any, sawFirstToken = false; const callArgs = new Map<string, { name: string; input: string }>(); const raw: unknown[] = [];
    await sse(response, (event, data) => { raw.push(data); if (data?.error) throw new Error(`Model API error: ${redactProviderError(String(data.error.message ?? data.error.code ?? JSON.stringify(data.error)), this.apiKey)}`); const hasOutput = event === 'response.output_text.delta' || event === 'response.reasoning_summary_text.delta' || (event === 'response.output_item.added' && data.item?.type === 'function_call') || event === 'response.function_call_arguments.delta'; if (!sawFirstToken && hasOutput) { sawFirstToken = true; options.onFirstToken?.(); } if (event === 'response.output_text.delta') { const fixed = fixDoubleEncoding(data.delta); content += fixed; options.onDelta?.(fixed); } if (event === 'response.reasoning_summary_text.delta') reasoning += data.delta; if (event === 'response.output_item.added' && data.item?.type === 'function_call') callArgs.set(data.item.call_id, { name: data.item.name, input: data.item.arguments ?? '' }); if (event === 'response.function_call_arguments.delta') { const call = callArgs.get(data.call_id ?? data.item_id); if (call) call.input += data.delta; } if (event === 'response.output_item.done' && data.item?.type === 'function_call') callArgs.set(data.item.call_id, { name: data.item.name, input: data.item.arguments ?? callArgs.get(data.item.call_id)?.input ?? '' }); if (event === 'response.completed') completed = data.response; });
    const usage = completed?.usage ?? {};
    const toolCalls = chatToolCalls([...callArgs].map(([id, call]) => ({ id, function: { name: call.name, arguments: call.input } })));
    return { content, reasoning, toolCalls, usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens, cachedInputTokens: usage.input_tokens_details?.cached_tokens }, raw };
  }
}
