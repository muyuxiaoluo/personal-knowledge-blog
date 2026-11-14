import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// A synthetic local API checks the real Harness loop without sending personal data.
const answer = JSON.stringify({ reply: '本机执行框架测试通过。', evidenceIds: [], actions: [] });
const requests = [];
const server = createServer(async (request, response) => {
  let input = '';
  for await (const chunk of request) input += chunk;
  const body = JSON.parse(input || '{}');
  requests.push({ url: request.url, tools: body.tools || [] });
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { id: 'fixture-message', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
  event('message_stop', {});
  response.end();
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const child = spawn(process.execPath, [resolve('sites-app/src-tauri/resources/companion-runtime.mjs')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '';
let error = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { error += chunk; });
const timeout = setTimeout(() => child.kill(), 35000);
child.stdin.end(JSON.stringify({ cli: resolve('deploy-artifacts/assistant-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'), home: resolve(`deploy-artifacts/assistant-fixtures/${randomUUID()}`), apiKey: 'synthetic-fixture-key', model: 'deepseek-flash', baseUrl: `http://127.0.0.1:${server.address().port}`, instructions: 'Return a short JSON response.', prompt: 'Synthetic protocol check. No personal information.' }));
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, `${output}\n${error}`);
  assert.equal(JSON.parse(output).text, answer);
  assert.ok(requests.length >= 1);
  assert.ok(requests.every(request => request.url.endsWith('/messages')), 'unexpected secondary upload');
  assert.ok(requests.every(request => request.tools.length === 0), 'unrestricted tools must not be exposed');
  console.log('Real Harness SDK: initialization, streaming response, completion and tool isolation passed.');
} finally { clearTimeout(timeout); child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
