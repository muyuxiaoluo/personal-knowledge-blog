// Read-only protocol probe. No turn/start or model request is issued.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const executable = process.argv[2] || 'codex';
const child = spawn(executable, ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let sequence = 0;
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  } catch { /* Non-protocol startup diagnostics are not session content. */ }
});
child.stderr.resume();
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
  pending.set(id, (message) => { clearTimeout(timeout); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); });
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
});
try {
  await request('initialize', { clientInfo: { name: 'personal_workbench_probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  const result = await request('thread/list', { limit: 5, sortKey: 'updated_at', sourceKinds: [] });
  const threads = result.data || [];
  console.log(JSON.stringify({ connected: true, count: threads.length, fields: Object.keys(threads[0] || {}), hasMore: Boolean(result.nextCursor) }));
  if (threads[0]) {
    const selected=threads.find(thread=>String(thread.cwd).replaceAll('\\','/').toLowerCase()===process.cwd().replaceAll('\\','/').toLowerCase()) || threads[0];
    const history = await request('thread/turns/list', { threadId: selected.id, limit: 20, itemsView: 'summary' });
    const items = (history.data || []).flatMap(turn => turn.items || []);
    console.log(JSON.stringify({ historyReadable: true, turns: history.data?.length, bytes: JSON.stringify(history).length, turnFields: Object.keys(history.data?.[0] || {}), startedAt: history.data?.[0]?.startedAt, updatedAt: threads[0].updatedAt, status: threads[0].status, itemShapes: [...new Map(items.map(item => [item.type, { type: item.type, fields: Object.keys(item) }])).values()] }));
    if(history.data?.[0]) {
      const details=await request('thread/items/list',{threadId:selected.id,turnId:history.data[0].id,limit:6,sortDirection:'desc'});
      console.log(JSON.stringify({detailsReadable:true,items:details.data?.length,bytes:JSON.stringify(details).length,fields:Object.keys(details.data?.[0]||{}),itemTypes:details.data?.map(entry=>(entry.item||entry).type)}));
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { lines.close(); child.kill(); }
