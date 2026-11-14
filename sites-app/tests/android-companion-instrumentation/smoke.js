// Runs inside the installed optimized app, through the test-only instrumentation.
// Requires the isolated emulator user and synthetic upgrade baseline, never a real account.
const invoke = window.__TAURI_INTERNALS__.invoke;
const query = query => invoke('plugin:sql|select', { db:'sqlite:mind-garden.db', query, values:[] });
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const assert = (value, message) => { if (!value) throw new Error(message); };
async function waitFor(check, message) { for (let i=0;i<100;i++) { if (await check()) return; await pause(); } throw new Error(message); }
const button = text => Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes(text));
const home = async () => { document.querySelector('header button').click(); await waitFor(() => document.querySelector('.account-entry'), 'Home did not return'); };
const input = (element, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles:true })); };
const labelInput = text => Array.from(document.querySelectorAll('label')).find(l => l.textContent.trim() === text)?.querySelector('input');
const layout = () => assert(document.documentElement.scrollWidth <= innerWidth, 'Horizontal page overflow');
assert((await query("SELECT value FROM private_meta WHERE key='enabled'"))[0]?.value !== '1', 'Private sync must be disabled');
assert((await invoke('plugin:companion-secrets|get', { key:'private_'+'c'.repeat(64) })) === 'synthetic-optimized-build-check', 'Existing Keystore value did not survive upgrade');
const original = await query('SELECT id,state,amount_cents,duplicate_of FROM finance_capture_events');
assert(original.length >= 5 && original.some(r => r.state === 'duplicate') && original.some(r => r.state === 'completed' && r.amount_cents === 2180), 'Original financial evidence was lost');
assert((await query('SELECT id FROM health_meal_photos')).length >= 1, 'Original meal photo was lost');
await invoke('plugin:companion-finance|configure', { enabled:true, instant:true });
const nativeStatus = await invoke('plugin:companion-finance|status');
assert(!nativeStatus.error && nativeStatus.enabled && nativeStatus.access && nativeStatus.notifications, 'Native finance initialization failed');
layout();
button('账户与私人同步设置').click(); await waitFor(() => document.body.innerText.includes('交易通知自动记录'), 'Account page missing'); layout(); await home();

document.querySelector('.entry.health').click();
await waitFor(() => labelInput('步数') && !document.querySelector('fieldset').disabled, 'Health form not ready');
input(labelInput('小时'), '8'); input(labelInput('步数'), '4321'); await pause();
document.querySelector('form').requestSubmit(); await waitFor(() => document.querySelector('.account-entry'), 'Health save failed');
assert((await query('SELECT steps,sleep_minutes FROM health_daily_logs ORDER BY log_date DESC LIMIT 1'))[0]?.steps === 4321, 'Health SQLite write failed');

document.querySelector('.entry.money').click(); await waitFor(() => labelInput('金额（元）'), 'Expense form missing');
input(labelInput('金额（元）'), '12.34'); input(labelInput('说明'), '优化包合成测试消费'); await pause();
document.querySelector('form').requestSubmit(); await waitFor(() => document.querySelector('.account-entry'), 'Expense save failed');
assert((await query("SELECT amount_cents FROM finance_transactions WHERE description='优化包合成测试消费'"))[0]?.amount_cents === 1234, 'Expense SQLite write failed');

button('记一餐').click(); await waitFor(() => document.querySelector('input[type=file][multiple]'), 'Meal photo page missing');
const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320;
const context = canvas.getContext('2d'); context.fillStyle = '#dbe9d8'; context.fillRect(0,0,480,320); context.fillStyle = '#335d4b'; context.font = '24px sans-serif'; context.fillText('Optimized APK test ' + Date.now(),20,150);
const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
const files = new DataTransfer(); files.items.add(new File([blob], 'optimized-test.jpg', { type:'image/jpeg', lastModified:Date.now() }));
const picker = document.querySelector('input[type=file][multiple]'); picker.files = files.files; picker.dispatchEvent(new Event('change', { bubbles:true }));
await waitFor(() => button('保存 1 张餐食照片'), 'Meal photo preparation failed'); layout();
button('保存 1 张餐食照片').click(); await waitFor(() => document.querySelector('.account-entry'), 'Meal photo save failed');
const photos = await query('SELECT id FROM health_meal_photos'); assert(photos.length >= 2, 'New meal photo missing');
button('记一餐').click(); await waitFor(() => document.querySelector('.meal-photo-card img'), 'Meal photo reopening failed'); layout(); await home();

button('交易待补全').click(); await waitFor(() => document.querySelector('.capture-row'), 'Capture inbox missing'); layout();
Array.from(document.querySelectorAll('.capture-row')).find(r => r.textContent.includes('3.60')).click();
await waitFor(() => document.querySelector('.capture-form'), 'Capture form missing');
input(document.querySelector('.capture-form input:not([type=checkbox])'), '优化包补全测试'); await pause();
document.querySelector('.capture-form').requestSubmit();
await waitFor(async () => (await query("SELECT id FROM finance_transactions WHERE description='优化包补全测试'")).length === 1, 'Atomic capture completion failed');
await home();
await invoke('plugin:companion-secrets|set', { key:'private_'+'d'.repeat(64), value:'synthetic-r8-secret-check' });
assert((await invoke('plugin:companion-secrets|get', { key:'private_'+'d'.repeat(64) })) === 'synthetic-r8-secret-check', 'Keystore roundtrip failed');
await invoke('plugin:companion-secrets|remove', { key:'private_'+'d'.repeat(64) });
layout();
return { preservedCaptureCount:original.length, photoCount:photos.length, healthSave:true, expenseSave:true, captureCompletion:true, keystoreUpgrade:true, keystoreRoundtrip:true, nativeFinance:true, horizontalOverflow:false };
