// Actual release APK, isolated offline user 10; optionally run after the
// instrumentation's test-only system unbind (--unbind-listener).
const invoke = window.__TAURI_INTERNALS__.invoke;
const query = query => invoke('plugin:sql|select', { db:'sqlite:mind-garden.db', query, values:[] });
const assert = (value, message) => { if (!value) throw new Error(message); };
assert((await query("SELECT value FROM private_meta WHERE key='enabled'"))[0]?.value !== '1', 'Requires offline fixture');
const count = (await query('SELECT count(*) n FROM finance_capture_events'))[0].n;
let status = await invoke('plugin:companion-finance|status');
assert(status.enabled && status.access, 'Fixture requires capture and access enabled');
for (let i=0;i<100 && !status.connected;i++) {
  await new Promise(resolve=>setTimeout(resolve,200)); status=await invoke('plugin:companion-finance|status');
}
assert(status.connected, 'Visible status checks did not recover the listener');
document.querySelector('.account-entry').click();
for (let i=0;i<100 && !document.body.innerText.includes('重新连接接收服务');i++) await new Promise(r=>setTimeout(r,100));
const button = text => [...document.querySelectorAll('button')].find(item=>item.textContent.trim()===text);
assert(button('重新连接接收服务'), 'Manual reconnect control missing');
button('重新连接接收服务').click();
for (let i=0;i<120 && !document.body.innerText.includes('接收服务已连接，可点击');i++) await new Promise(r=>setTimeout(r,200));
assert(document.body.innerText.includes('接收服务已连接，可点击'), 'Manual reconnect did not report the resulting state');
button('测试提醒').click();
for (let i=0;i<100 && !document.body.innerText.includes('通知收发检查通过');i++) await new Promise(r=>setTimeout(r,150));
assert(document.body.innerText.includes('通知收发检查通过'), 'Listener could not receive after reconnect');
assert((await query('SELECT count(*) n FROM finance_capture_events'))[0].n === count, 'Reconnect duplicated or created a transaction');
assert(document.documentElement.scrollWidth <= innerWidth, 'Reconnect settings overflow horizontally');
return { listenerConnected:true, manualReconnectWorks:true, notificationReceiptConfirmed:true, existingRecordCount:count, noTransactionsAdded:true };
