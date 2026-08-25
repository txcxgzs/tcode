import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4090);
let calls = 0;
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'browser-e2e', name: 'Browser E2E' }] }));
    return;
  }
  let raw = '';
  request.on('data', (chunk) => raw += chunk);
  request.on('end', async () => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    JSON.parse(raw);
    calls += 1;
    if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 1200));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (calls === 1) {
      response.write('data: {"choices":[{"delta":{"reasoning_content":"I will create the requested verification artifact."}}]}\n\n');
      const input = { command: 'create', path: `${process.cwd()}\\browser-e2e-artifact.txt`, file_text: 'browser e2e verified\n' };
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'browser_call_1', function: { name: 'str_replace_editor', arguments: JSON.stringify(input) } }] } }] })}\n\n`);
    } else {
      response.write('data: {"choices":[{"delta":{"content":"已创建并验证浏览器端到端产物。"}}]}\n\n');
    }
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, prompt_tokens_details: { cached_tokens: calls > 1 ? 12 : 0 } } })}\n\n`);
    response.write('data: [DONE]\n\n');
    response.end();
  });
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`mock-provider:${port}\n`));
