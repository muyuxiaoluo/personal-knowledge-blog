import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Credentials arrive through stdin; stdout contains only our bounded result.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
await mkdir(request.home, { recursive: true });
const child = spawn(process.execPath, [request.cli, '--profile', 'sdk-minimal', '--patch', resolve(dirname(fileURLToPath(import.meta.url)), 'companion-runtime.patch.yml')], {
  windowsHide: true,
  cwd: request.home,
  env: { ...process.env, DSH_HOME: request.home, DEEPSEEK_API_KEY: request.apiKey, DEEPSEEK_BASE_URL: request.baseUrl || 'https://api.deepseek.com/anthropic', DSH_SYSTEM_PROMPT: request.instructions },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let id = 0;
let answer = '';
let diagnostic = '';
child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-3000); });
const failAll = message => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(message)); } pending.clear(); };
child.on('error', error => failAll(error.message));
child.on('exit', code => failAll(`执行框架已退出（${code}）。${diagnostic.replaceAll(request.apiKey, '[已隐藏]')}`));
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  const waiting = pending.get(frame.id);
  if (waiting) {
    clearTimeout(waiting.timer); pending.delete(frame.id);
    frame.error ? waiting.reject(new Error(frame.error.message || '执行框架请求失败')) : waiting.resolve(frame.result);
  }
  const event = frame.params?.event;
  if (frame.method === 'session.event' && event?.type === 'assistant/message') {
    answer = (event.data?.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
  }
  // This profile exposes no process, filesystem, or external action tools.
  if (frame.method && frame.id !== undefined) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'This workbench host does not accept unsolicited requests.' } })}\n`);
});
const rpc = (method, params, timeout = 30000) => new Promise((resolve, reject) => {
  const key = ++id;
  const timer = setTimeout(() => { pending.delete(key); reject(new Error('执行框架响应超时，请稍后重试。')); }, timeout);
  pending.set(key, { resolve, reject, timer });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: key, method, params })}\n`);
});
try {
  await rpc('initialize', { cwd: request.home, provider: 'deepseek-official', model: request.model, maxTokens: 2500, reasoningEffort: 'low', approvalRequests: true });
  if (request.probe) { process.stdout.write(JSON.stringify({ ready: true })); lines.close(); child.stdin.end(); child.kill(); process.exit(0); }
  const sessionId = `workbench-${Date.now()}`;
  await rpc('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: request.prompt }] });
  await rpc('session/wait', { sessionId }, 110000);
  if (!answer.trim() || answer.length > 24000) throw new Error('执行框架未返回有效答复。');
  process.stdout.write(JSON.stringify({ text: answer }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error.message).replaceAll(request.apiKey, '[已隐藏]') }));
  process.exitCode = 1;
} finally {
  lines.close(); child.stdin.end(); child.kill();
}
