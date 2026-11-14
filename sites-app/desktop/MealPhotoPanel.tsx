import { useCallback, useEffect, useRef, useState } from "react";
import type { MealPhotoRepository } from "../app/data/meal-photo-repository";
import { mealSlotAt, prepareMealPhoto, type MealPhoto } from "../app/meal-photo";
import { healthMealSlots } from "../app/health-types";
import { Button } from "./DesktopControls";
import { desktopApi } from "./integrationApi";

export function MealPhotoPanel({ repository, date, dirty, hasKey, onConfirmed, onSaving }: { repository: MealPhotoRepository; date: string; dirty: boolean; hasKey: boolean; onConfirmed: () => Promise<void>; onSaving: (saving: boolean) => void }) {
  const [photos, setPhotos] = useState<MealPhoto[]>([]), [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(""), [message, setMessage] = useState(""), [removing, setRemoving] = useState("");
  const input = useRef<HTMLInputElement>(null), activeDate = useRef(date);
  activeDate.current = date;
  const refresh = useCallback(async () => {
    const rows = await repository.list(date);
    if (activeDate.current !== date) return;
    setPhotos(rows);
    setDrafts(current => Object.fromEntries(rows.map(p => [p.id, current[p.id] ?? p.description])));
  }, [repository, date]);
  useEffect(() => {
    let active = true;
    const update = () => { if (active) void refresh().catch(() => { if (active) setMessage("读取餐食照片失败，请重试。"); }); };
    update(); const timer = window.setInterval(update, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [refresh]);
  const recognize = async (photo: MealPhoto) => {
    setBusy(photo.id); setMessage("");
    try {
      const response = await desktopApi.deepseek.recognizeMeal(photo.imageDataUrl);
      const text = response.content.description.trim();
      if (!text || text.length > 1000) throw new Error("识别结果无效，请手动补充描述或重试。");
      await repository.draft(photo.id, text);
      if (activeDate.current === photo.date) setDrafts(d => ({ ...d, [photo.id]: text }));
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "识别未完成，照片已保留，可重试。"); }
    finally { setBusy(""); }
  };
  const importPhotos = async (files: File[]) => {
    if (files.length > 12) { setMessage("每次最多导入 12 张照片。"); return; }
    setBusy("import"); setMessage("");
    let count = 0;
    try {
      for (const file of files) {
        const p = await prepareMealPhoto(file);
        if (await repository.add({ id: p.id, date, slot: mealSlotAt(p.time), eatenAt: p.time, capturedAt: p.capturedAt, imageDataUrl: p.imageDataUrl, description: "", reviewed: false, createdAt: new Date().toISOString() })) count++;
      }
      await refresh(); setMessage(`已导入 ${count} 张照片，重复照片已跳过。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "导入未完成，可重试；已保存的照片会保留。"); await refresh(); }
    finally { setBusy(""); }
  };
  return <div className="health-photo-panel" role="region" aria-label="餐食照片">
    <header><div><strong>餐食照片</strong><p>保存照片与可修改的草稿，确认后追加到该餐记录。</p></div><Button size="small" disabled={Boolean(busy)} onClick={() => input.current?.click()}>导入照片</Button></header>
    <input ref={input} className="health-meal-file" type="file" multiple accept="image/jpeg,image/png,image/webp" aria-label="导入餐食照片" onChange={e => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ""; void importPhotos(files); }} />
    <p className="health-meal-photo-note">点击“识别照片”后发送这张压缩照片给已配置的 AI 图片识别服务。确认后才写入餐食。</p>
    {!hasKey && <p className="health-meal-photo-note">请先在“设置 → AI 与模型”配置图片识别所用的 API Key。</p>}
    {dirty && <p className="health-meal-photo-note">请先保存当天编辑，再确认照片草稿。</p>}
    {photos.length === 0 && <p className="health-photo-empty">这一天还没有餐食照片，可先导入电脑里的照片。</p>}
    <div className="health-photo-grid">{photos.map(photo => <article className="health-photo-card" key={photo.id}>
      <img src={photo.imageDataUrl} alt={`${photo.eatenAt} ${healthMealSlots.find(s => s.value === photo.slot)?.label}餐食照片`} loading="lazy" />
      <p>{photo.eatenAt} · {healthMealSlots.find(s => s.value === photo.slot)?.label} · {photo.reviewed ? "已记入餐食" : "待确认"}</p>
      {photo.reviewed ? <p>{photo.description}</p> : <><textarea rows={3} maxLength={1000} aria-label={`${photo.eatenAt}餐食照片描述`} value={drafts[photo.id] ?? photo.description} disabled={Boolean(busy)} placeholder="识别照片，或手动填写吃了什么" onChange={e => setDrafts(d => ({ ...d, [photo.id]: e.target.value }))} />
        <div className="health-photo-actions"><Button size="small" disabled={Boolean(busy) || !hasKey} onClick={() => void recognize(photo)}>{busy === photo.id ? "处理中…" : "识别照片"}</Button>
        <Button size="small" variant="primary" disabled={Boolean(busy) || dirty || !(drafts[photo.id] ?? photo.description).trim()} onClick={() => {
          setBusy(photo.id); setMessage(""); onSaving(true);
          void repository.confirm(photo.id, drafts[photo.id] ?? photo.description).then(onConfirmed).then(refresh).catch(error => setMessage(error instanceof Error ? error.message : "保存未完成，请重试。")).finally(() => { setBusy(""); onSaving(false); });
        }}>确认记入该餐</Button></div></>}
      {removing === photo.id ? <div><p>删除这张照片？已确认的餐食文字会保留。</p><Button size="small" disabled={Boolean(busy)} onClick={() => setRemoving("")}>取消</Button><Button size="small" variant="danger" disabled={Boolean(busy)} onClick={() => { setBusy(photo.id); void repository.remove(photo.id).then(refresh).then(() => setRemoving("")).catch(() => setMessage("删除未完成，请重试。")).finally(() => setBusy("")); }}>确认删除照片</Button></div> : <Button size="small" variant="quiet" disabled={Boolean(busy)} onClick={() => setRemoving(photo.id)}>删除照片</Button>}
    </article>)}</div>
    {message && <p role="status">{message}</p>}
  </div>;
}
