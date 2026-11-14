// Actual release-APK UI test; run once with access, once after revoking access
// only in isolated FinanceCaptureTest user 10. Never creates a payment fixture.
const invoke = window.__TAURI_INTERNALS__.invoke;
const query = query => invoke('plugin:sql|select', { db:'sqlite:mind-garden.db', query, values:[] });
const assert = (value, message) => { if (!value) throw new Error(message); };
assert((await query("SELECT value FROM private_meta WHERE key='enabled'"))[0]?.value !== '1', 'Requires offline fixture');
// Exercise the capture configuration path without changing its start time.
await invoke('plugin:companion-finance|configure', { enabled:true, instant:true });
let before = await invoke('plugin:companion-finance|status');
for (let i=0; i<100 && before.access && !before.connected; i++) {
  await new Promise(resolve=>setTimeout(resolve,100)); before=await invoke('plugin:companion-finance|status');
}
assert(!before.access || before.connected, 'Service did not recover after startup');
const count = (await query('SELECT count(*) n FROM finance_capture_events'))[0].n;
document.querySelector('.account-entry').click();
for (let i=0;i<100 && !document.body.innerText.includes('测试提醒');i++) await new Promise(r=>setTimeout(r,100));
const button = [...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='测试提醒');
assert(button, 'Test reminder control missing');
const startedAt = Date.now();
button.click();
const expected = before.access ? '通知收发检查通过' : '测试提醒已发出，但系统尚未授予通知访问';
for (let i=0;i<100 && !document.body.innerText.includes(expected);i++) await new Promise(r=>setTimeout(r,150));
assert(document.body.innerText.includes(expected), 'Self-test UI did not distinguish receiving from sending');
if (!before.access) assert(Date.now() - startedAt >= 7500, 'Self-test stopped waiting on the permission flag before checking its receipt');
const after = await invoke('plugin:companion-finance|status');
assert(after.lastSeenAt === before.lastSeenAt, 'Self-test contaminated source-notification diagnostics');
if (before.access) assert(after.lastProbeAt > before.lastProbeAt && after.lastProbeToken !== before.lastProbeToken, 'Fresh acknowledgement missing');
else assert(after.lastProbeToken === before.lastProbeToken, 'A previous acknowledgement was mistaken for the new probe');
assert((await query('SELECT count(*) n FROM finance_capture_events'))[0].n === count, 'Self-test created a financial record');
assert(document.documentElement.scrollWidth <= innerWidth, 'Diagnostic settings overflow horizontally');
return { listenerAccess:before.access, listenerConnected:before.connected, correctSelfTestMessage:true, freshAcknowledgement:before.access, noFinancialRecordsCreated:true };
