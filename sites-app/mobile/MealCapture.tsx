import { useEffect, useRef, useState } from "react";
import { healthMealSlots } from "../app/health-types";
import { mealSlotAt, prepareMealPhoto, type MealPhoto } from "../app/meal-photo";
import type { MealPhotoRepository } from "../app/data/meal-photo-repository";
import { today } from "./RecordForms";

type PendingPhoto = MealPhoto & { estimated: boolean };
export function MealCapture({ repository, syncEnabled, onSaved }: { repository: MealPhotoRepository; syncEnabled: boolean; onSaved: () => Promise<void> }) {
  const camera = useRef<HTMLInputElement>(null), album = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [existing, setExisting] = useState<MealPhoto[]>([]);
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(() => { let active = true; void repository.list(date).then(rows => { if (active) setExisting(rows); }).catch(() => { if (active) setMessage("读取照片失败，请重试。"); }); return () => { active = false; }; }, [repository, date]);
  const select = async (files: File[]) => {
    if (files.length + pending.length > 12) { setMessage("每次最多添加 12 张照片，请先保存这一批。"); return; }
    setBusy(true); setMessage("");
    let duplicates = 0;
    const selected = new Set(pending.map(p => p.id));
    try {
      for (const file of files) {
        const prepared = await prepareMealPhoto(file);
        const item: PendingPhoto = { ...prepared, date: prepared.date > today() ? today() : prepared.date, slot: mealSlotAt(prepared.time), eatenAt: prepared.time, description: "", reviewed: false, createdAt: new Date().toISOString() };
        if (selected.has(item.id)) { duplicates++; continue; }
        selected.add(item.id); setPending(items => [...items, item]);
      }
      setMessage(duplicates ? "已跳过重复照片，请核对日期与餐次。" : "请核对日期与餐次，然后保存。可不填文字。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "照片处理失败，请重试。"); }
    finally { setBusy(false); }
  };
  const patch = (id: string, value: Partial<PendingPhoto>) => setPending(items => items.map(p => p.id === id ? { ...p, ...value } : p));
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      for (const item of pending) { await repository.add(item); setPending(items => items.filter(p => p.id !== item.id)); }
      await onSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存未完成，已保存的照片不会丢失，可重试剩余照片。"); }
    finally { setBusy(false); }
  };
  return <section className="card meal-capture">
    <h2>拍一下，留住这一餐</h2><p>直接拍照，或一次选入相册里的饭菜照片。保存压缩照片，保留原相册文件。</p>
    <p className="muted">{syncEnabled ? "照片先保存在手机，保存后联网自动加密同步到电脑。AI 识别在电脑点击后进行。" : "照片先保存在手机。到“账户与私人同步设置”配对，并在手机和电脑开启“同步餐食照片”，即可传到电脑。"}</p>
    <input ref={camera} className="meal-file-input" type="file" accept="image/*" capture="environment" aria-label="拍摄餐食照片" onChange={e => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ""; void select(files); }} />
    <input ref={album} className="meal-file-input" type="file" multiple accept="image/jpeg,image/png,image/webp" aria-label="选择餐食照片" onChange={e => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ""; void select(files); }} />
    <div className="two-fields"><button disabled={busy} onClick={() => camera.current?.click()}>拍照记一餐</button><button disabled={busy} onClick={() => album.current?.click()}>从相册选择</button></div>
    {pending.map(photo => <article className="meal-photo-card" key={photo.id}>
      <img src={photo.imageDataUrl} alt="待保存的餐食照片" />
      <fieldset disabled={busy}>
        <div className="two-fields"><label>日期<input type="date" max={today()} required value={photo.date} onChange={e => patch(photo.id, { date: e.target.value })} /></label><label>时间<input type="time" required value={photo.eatenAt} onChange={e => patch(photo.id, { eatenAt: e.target.value })} /></label></div>
        {photo.estimated && <p className="muted">照片没有可读的拍摄时间，已用文件时间预选，请核对。</p>}
        <label>餐次<select value={photo.slot} onChange={e => patch(photo.id, { slot: e.target.value as MealPhoto["slot"] })}>{healthMealSlots.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label>
        <label>补充说明（可选）<textarea maxLength={1000} value={photo.description} placeholder="也可以留空，之后在电脑上识别" onChange={e => patch(photo.id, { description: e.target.value })} /></label>
        <button onClick={() => setPending(items => items.filter(p => p.id !== photo.id))}>移出本次选择</button>
      </fieldset>
    </article>)}
    {pending.length > 0 && <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? "正在处理…" : `保存 ${pending.length} 张餐食照片`}</button>}
    {message && <p role="status">{message}</p>}
    <h2>已保存的照片</h2><label>查看日期<input type="date" max={today()} value={date} onChange={e => { if (e.target.value) setDate(e.target.value); }} /></label>
    {existing.length === 0 && <p className="muted">这一天还没有餐食照片。</p>}
    {existing.map(photo => <article className="meal-photo-card" key={photo.id}><img src={photo.imageDataUrl} alt={`${photo.date} ${photo.eatenAt} 的餐食`} /><p>{photo.eatenAt} · {healthMealSlots.find(s => s.value === photo.slot)?.label} · {photo.reviewed ? "已记入餐食" : "待确认"}</p>{photo.description && <p>{photo.description}</p>}</article>)}
  </section>;
}
