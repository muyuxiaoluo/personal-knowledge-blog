// Run after posting isolated WeChat fixtures: 171 with the old APK, then
// 172 (WeChat Pay), 173 (ordinary chat), 174 (failed payment) after upgrade.
const invoke = window.__TAURI_INTERNALS__.invoke;
const query = query => invoke('plugin:sql|select', { db:'sqlite:mind-garden.db', query, values:[] });
const assert = (value, message) => { if (!value) throw new Error(message); };
assert((await query("SELECT value FROM private_meta WHERE key='enabled'"))[0]?.value !== '1', 'Requires offline fixture');
const rows = await query("SELECT amount_cents,kind,count(*) n FROM finance_capture_events WHERE source='wechat' AND amount_cents BETWEEN 171 AND 174 GROUP BY amount_cents,kind");
assert(rows.length === 2, 'Ordinary chat or failed payment was recorded');
assert(rows.some(row => row.amount_cents === 171 && row.kind === 'unknown' && row.n === 1), 'Upgrade changed or duplicated an existing notification');
assert(rows.some(row => row.amount_cents === 172 && row.kind === 'expense' && row.n === 1), 'WeChat paid notification was not captured as an expense');
const status = await invoke('plugin:companion-finance|status');
assert(status.lastCaptureAt > 0 && status.lastReminderAt > 0, 'Capture/reminder path was not observed');
return { wechatPaidCapturedAsExpense:true, previousRecordPreserved:true, ordinaryChatExcluded:true, failedPaymentExcluded:true, reminderSubmitted:true };
