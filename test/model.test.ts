import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discoverModels, OpenAICompatibleModel } from '../src/model.js';

let server: Server | undefined;
afterEach(() => server?.close());

async function mock(handler: (request: any, body: any) => { status?: number; headers?: Record<string, string>; body: any }) {
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => raw += chunk);
    request.on('end', () => {
      const result = handler(request, raw ? JSON.parse(raw) : undefined);
      response.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...result.headers });
      response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

describe('OpenAI-compatible model adapter', () => {
  it('discovers and de-duplicates models using the bearer credential', async () => {
    const baseUrl = await mock((request) => {
      expect(request.url).toBe('/v1/models');
      expect(request.headers.authorization).toBe('Bearer sk-test-only');
      return { body: { data: [{ id: 'model-a' }, { id: 'model-a' }, { id: 'model-b', name: 'Model B' }] } };
    });
    await expect(discoverModels(baseUrl, 'sk-test-only')).resolves.toEqual([{ id: 'model-a', name: undefined }, { id: 'model-b', name: 'Model B' }]);
  });

  it('accepts a non-streaming Chat Completions response and tool call', async () => {
    const baseUrl = await mock((_request, body) => {
      expect(body.tools.map((tool: any) => tool.function.name)).toEqual(['pwsh', 'str_replace_editor']);
      expect(body.tools[0].function.parameters.required).toEqual(['command']);
      return { body: { choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'pwsh', arguments: '{"command":"pwd"}' } }] } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 3 } } } };
    });
    const model = new OpenAICompatibleModel({ baseUrl, model: 'test', protocol: 'chat-completions', maxOutputTokens: 100, contextBudget: 1000 }, 'sk-test-only');
    const turn = await model.complete([{ role: 'user', content: 'inspect' }]);
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'pwsh', input: { command: 'pwd' } }]);
    expect(turn.usage.totalTokens).toBe(6);
    expect(turn.usage.cachedInputTokens).toBe(3);
  });

  it('assembles fragmented Chat Completions SSE tool calls and usage', async () => {
    const baseUrl = await mock(() => ({
      headers: { 'content-type': 'text/event-stream' },
      body: [
        'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"pw","arguments":"{\\"command\\":\\"p"}}]}}]}',
        '',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"sh","arguments":"wd\\"}"}}]}}]}',
        '',
        'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11,"prompt_tokens_details":{"cached_tokens":5}}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
    }));
    const model = new OpenAICompatibleModel({ baseUrl, model: 'test', protocol: 'chat-completions', maxOutputTokens: 100, contextBudget: 1000 }, 'sk-test-only');
    let firstTokens = 0;
    const turn = await model.complete([{ role: 'user', content: 'inspect' }], { onFirstToken: () => firstTokens += 1 });
    expect(turn.reasoning).toBe('think ');
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'pwsh', input: { command: 'pwd' } }]);
    expect(turn.usage.totalTokens).toBe(11);
    expect(turn.usage.cachedInputTokens).toBe(5);
    expect(firstTokens).toBe(1);
  });

  it('sends proper function tool outputs to the Responses API', async () => {
    const baseUrl = await mock((_request, body) => {
      expect(body.input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: 'ok' });
      expect(body.input).toContainEqual({ type: 'function_call', call_id: 'call_1', name: 'pwsh', arguments: '{"command":"pwd"}' });
      expect(body.tools.map((tool: any) => tool.name)).toEqual(['pwsh', 'str_replace_editor']);
      return { body: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 2 } } } };
    });
    const model = new OpenAICompatibleModel({ baseUrl, model: 'test', protocol: 'responses', maxOutputTokens: 100, contextBudget: 1000 }, 'sk-test-only');
    const turn = await model.complete([
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'pwsh', input: { command: 'pwd' } }] },
      { role: 'tool', content: 'ok', name: 'pwsh', toolCallId: 'call_1' },
    ]);
    expect(turn.content).toBe('done');
    expect(turn.usage.cachedInputTokens).toBe(2);
  });

  it('assembles Responses SSE text and function arguments', async () => {
    const baseUrl = await mock(() => ({
      headers: { 'content-type': 'text/event-stream' },
      body: [
        'event: response.output_text.delta', 'data: {"delta":"working"}', '',
        'event: response.output_item.added', 'data: {"item":{"type":"function_call","call_id":"c1","name":"pwsh","arguments":""}}', '',
        'event: response.function_call_arguments.delta', 'data: {"call_id":"c1","delta":"{\\"command\\":"}', '',
        'event: response.function_call_arguments.delta', 'data: {"call_id":"c1","delta":"\\"pwd\\"}"}', '',
        'event: response.completed', 'data: {"response":{"usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}}}', '',
      ].join('\n'),
    }));
    const deltas: string[] = [];
    let firstTokens = 0;
    const model = new OpenAICompatibleModel({ baseUrl, model: 'test', protocol: 'responses', maxOutputTokens: 100, contextBudget: 1000 }, 'sk-test-only');
    const turn = await model.complete([{ role: 'user', content: 'edit' }], { onDelta: (delta) => deltas.push(delta), onFirstToken: () => firstTokens += 1 });
    expect(deltas).toEqual(['working']);
    expect(turn.toolCalls).toEqual([{ id: 'c1', name: 'pwsh', input: { command: 'pwd' } }]);
    expect(turn.usage.totalTokens).toBe(13);
    expect(firstTokens).toBe(1);
  });

  it('redacts provider errors before surfacing them', async () => {
    const secret = 'sk-test-secret-123456789';
    const baseUrl = await mock(() => ({ status: 401, body: { error: { message: `invalid ${secret}` } } }));
    const model = new OpenAICompatibleModel({ baseUrl, model: 'test', protocol: 'chat-completions', maxOutputTokens: 100, contextBudget: 1000 }, secret);
    await expect(model.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('invalid [REDACTED]');
  });
});
