// Exercises the installed Tauri Android WebView through its debug port, never a Vite page.
// Use only with the isolated emulator user and synthetic notifications described in the validation notes.
const pages = await fetch("http://127.0.0.1:9224/json").then(r => r.json());
const target = pages.find(p => p.type === "page" && /tauri|localhost/.test(p.url));
if (!target) throw new Error("No installed Tauri WebView found");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let serial = 0;
const pending = new Map();
ws.onmessage = event => {
  const result = JSON.parse(event.data);
  if (pending.has(result.id)) { pending.get(result.id)(result); pending.delete(result.id); }
};
async function evaluate(expression) {
  const id = ++serial;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Native check timeout")); }, 15000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (result.error || result.result.exceptionDetails) throw new Error(JSON.stringify(result.error || result.result.exceptionDetails));
  return result.result.result.value;
}
const action = process.argv[2] || "inspect";
try {
  if (action === "inspect") console.log(await evaluate("JSON.stringify({url:location.href,text:document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth})"));
  else if (action === "enable") console.log(await evaluate("window.__TAURI_INTERNALS__.invoke('plugin:companion-finance|configure',{enabled:true,instant:true})"));
  else if (action === "status") console.log(await evaluate("window.__TAURI_INTERNALS__.invoke('plugin:companion-finance|status')"));
  else if (action === "diagnose") console.log(await evaluate("Promise.all([window.__TAURI_INTERNALS__.invoke('plugin:path|app_config_dir').catch(String),window.__TAURI_INTERNALS__.invoke('plugin:companion-finance|initialize').catch(String),window.__TAURI_INTERNALS__.invoke('plugin:sql|select',{db:'sqlite:mind-garden.db',query:'PRAGMA database_list',values:[]}).catch(String)])"));
  else if (action === "records") console.log(await evaluate("window.__TAURI_INTERNALS__.invoke('plugin:sql|select',{db:'sqlite:mind-garden.db',query:'SELECT id,source,amount_cents,kind,state,description,duplicate_of FROM finance_capture_events ORDER BY received_at',values:[]})"));
  else if (action === "inbox") console.log(await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('交易待补全')).click(); 'opened'"));
  else if (action === "home") console.log(await evaluate("Array.from(document.querySelectorAll('header button')).find(b=>b.textContent==='返回').click(); 'home'"));
  else if (action === "ledger") console.log(await evaluate("window.__TAURI_INTERNALS__.invoke('plugin:sql|select',{db:'sqlite:mind-garden.db',query:'SELECT amount_cents,kind,description,status FROM finance_transactions',values:[]})"));
  else if (action === "edit") console.log(await evaluate("document.querySelector('.capture-row').click(); 'editing'"));
  else if (action === "complete") console.log(await evaluate(`(() => {
    const form=document.querySelector('.capture-form');
    const selects=form.querySelectorAll('select'); selects[0].value='expense'; selects[0].dispatchEvent(new Event('change',{bubbles:true}));
    const input=form.querySelector('input:not([type=checkbox])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'模拟消费午饭'); input.dispatchEvent(new Event('input',{bubbles:true}));
    selects[1].value='food'; selects[1].dispatchEvent(new Event('change',{bubbles:true})); return 'filled';
  })()`));
  else if (action === "save") console.log(await evaluate("document.querySelector('.capture-form').requestSubmit(); 'submitted'"));
  else if (action === "link") console.log(await evaluate("document.querySelector('.capture-candidates button').click(); 'linked'"));
  else throw new Error("Unknown test action");
} finally { ws.close(); }
