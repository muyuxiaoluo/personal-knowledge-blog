// Release-APK regression, only in isolated FinanceCaptureTest emulator user 10.
const invoke = window.__TAURI_INTERNALS__.invoke;
const query = query => invoke('plugin:sql|select', { db:'sqlite:mind-garden.db', query, values:[] });
const assert = (value, message) => { if (!value) throw new Error(message); };
const enabled = (await query("SELECT value FROM private_meta WHERE key='enabled'"))[0]?.value;
assert(enabled !== '1', 'Private sync must remain disabled in this fixture');
const before = (await query('SELECT count(*) n FROM finance_capture_events'))[0].n;
assert((await query("SELECT count(*) n FROM finance_capture_events WHERE source='cmb' AND amount_cents=141"))[0].n === 1, 'Upgrade replay duplicated the original control transaction');
assert((await query("SELECT count(*) n FROM finance_capture_events WHERE source='cmb' AND amount_cents=140"))[0].n === 1, 'Previously skipped notification was not captured on reconnect');
assert((await query("SELECT count(*) n FROM finance_capture_events WHERE source='cmb' AND amount_cents=142"))[0].n === 1, 'Fresh notification with an old display time was skipped');
let status = await invoke('plugin:companion-finance|status');
for (let i=0;i<100 && !status.connected;i++) {
  await new Promise(resolve=>setTimeout(resolve,100)); status=await invoke('plugin:companion-finance|status');
}
assert(status.enabled && status.access && status.connected && status.notifications, 'Notification fixture is not connected');
assert(status.lastCaptureAt > 0 && status.lastReminderAt > 0, 'Synthetic transaction did not reach capture and reminder stages');
assert(status.instantImportance > 0, 'New-transaction channel is blocked');
for (let i=0;i<2;i++) assert((await invoke('plugin:companion-finance|test_reminder')).posted, 'Test reminder was blocked');
assert((await query('SELECT count(*) n FROM finance_capture_events'))[0].n === before, 'Test reminders created financial records');
document.querySelector('.account-entry').click();
for (let i=0;i<100 && !document.body.innerText.includes('测试提醒');i++) await new Promise(r=>setTimeout(r,100));
assert(document.body.innerText.includes('测试提醒') && document.body.innerText.includes('提醒显示设置'), 'Troubleshooting controls missing');
assert(document.body.innerText.includes('最近收到微信/招行通知') && document.body.innerText.includes('最近记入交易'), 'Local processing diagnostics missing');
if (status.instantImportance < 4) assert(document.body.innerText.includes('通道未允许顶部提示'), 'Existing channel importance needs visible guidance');
assert(document.documentElement.scrollWidth <= innerWidth, 'Notification settings overflow horizontally');
return { testReminderPosted:true, testReminderCreatesRecords:false, captureAndReminderObserved:true, diagnosticsVisible:true, instantImportance:status.instantImportance };
