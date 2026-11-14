const invoke = window.__TAURI_INTERNALS__.invoke;
const query = query => invoke('plugin:sql|select', { db:'sqlite:mind-garden.db', query, values:[] });
if ((await query("SELECT value FROM private_meta WHERE key='enabled'"))[0]?.value === '1') throw new Error('Requires isolated offline fixture');
await invoke('plugin:companion-finance|configure', { enabled:true, instant:true });
let status = await invoke('plugin:companion-finance|status');
for (let i=0;i<100 && !status.connected;i++) {
  await new Promise(resolve=>setTimeout(resolve,100)); status=await invoke('plugin:companion-finance|status');
}
return { count:(await query('SELECT count(*) n FROM finance_capture_events'))[0].n, enabled:status.enabled, connected:status.connected, access:status.access, notifications:status.notifications, lastSeenAt:status.lastSeenAt, lastCaptureAt:status.lastCaptureAt, lastReminderAt:status.lastReminderAt, lastOutcome:status.lastOutcome, error:status.error };
