import "./styles/health.css";
import { Button } from "./DesktopControls";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { resolveAvailableDeepSeekModel } from "../app/ai-model-settings";
import { saveHealthDay, type HealthRepository } from "../app/data/health-repository";
import {
  analyzeHealthDay,
  bmiBandLabel,
  buildHealthAiInput,
  calculateSleepMinutes,
  calculateBmi,
  formatHealthAiAdviceMarkdown,
  formatSleepDuration,
  formatSleepDurationEntry,
  parseSleepDurationEntry,
  resolveSleepMinutes,
  updateSleepClock,
  validateHealthAiAdviceContent,
} from "../app/health-helpers";
import {
  emptyHealthDailyLog,
  emptyHealthProfile,
  healthMealSlots,
  type HealthAiReport,
  type HealthDailyLog,
  type HealthMeal,
  type HealthMealSlot,
  type HealthProfile,
} from "../app/health-types";
import { MarkdownDocument } from "./MarkdownDocument";
import { ThemeSticker } from "./DesktopThemes";
import { SelectMenu } from "./DesktopControls";
import { desktopApi } from "./integrationApi";
import { XiaomiHealthPanel } from "./XiaomiHealthPanel";
import { MealPhotoPanel } from "./MealPhotoPanel";
import { pauseXiaomiForEditing, XIAOMI_BUSY_EVENT, XIAOMI_SYNC_EVENT, xiaomiSyncBusy } from "./xiaomi-sync";
import type { XiaomiDayState } from "../app/xiaomi-health";

type HealthTab = "today" | "trends" | "profile";

type MealDraft = Record<HealthMealSlot, { eatenAt: string; description: string }>;

const emptyMealDraft: MealDraft = {
  breakfast: { eatenAt: "", description: "" },
  lunch: { eatenAt: "", description: "" },
  dinner: { eatenAt: "", description: "" },
  snack: { eatenAt: "", description: "" },
};

export function HealthPage({
  repository,
  today,
  onChanged,
  onNotice,
  onOpenAiSettings,
}: {
  repository: HealthRepository;
  today: string;
  onChanged: () => void;
  onNotice: (message: string) => void;
  onOpenAiSettings: () => void;
}) {
  const [tab, setTab] = useState<HealthTab>("today");
  const [selectedDate, setSelectedDate] = useState(today);
  const [profile, setProfile] = useState<HealthProfile>(() => structuredClone(emptyHealthProfile));
  const [daily, setDaily] = useState<HealthDailyLog>(() => emptyHealthDailyLog(today));
  const [mealDrafts, setMealDrafts] = useState<MealDraft>(() => structuredClone(emptyMealDraft));
  const [recentLogs, setRecentLogs] = useState<HealthDailyLog[]>([]);
  const [report, setReport] = useState<HealthAiReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [savedSignature, setSavedSignature] = useState("");
  const [syncRevision, setSyncRevision] = useState(0);
  const [xiaomiDay, setXiaomiDay] = useState<XiaomiDayState | null>(null);
  const [sourceBusy, setSourceBusy] = useState(xiaomiSyncBusy);
  const [photoSaving, setPhotoSaving] = useState(false);
  const dirty = !loading && savedSignature !== JSON.stringify([daily, mealDrafts]);
  useEffect(() => {
    pauseXiaomiForEditing(dirty);
    return () => pauseXiaomiForEditing(false);
  }, [dirty]);
  useEffect(() => {
    const reload = () => setSyncRevision(value => value + 1);
    const updateBusy = () => setSourceBusy(xiaomiSyncBusy());
    window.addEventListener(XIAOMI_SYNC_EVENT, reload);
    window.addEventListener(XIAOMI_BUSY_EVENT, updateBusy);
    return () => { window.removeEventListener(XIAOMI_SYNC_EVENT, reload); window.removeEventListener(XIAOMI_BUSY_EVENT, updateBusy); };
  }, []);
  const [saving, setSaving] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStage, setAiStage] = useState("");
  const [mealAdviceOpen, setMealAdviceOpen] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [hasDeepSeekKey, setHasDeepSeekKey] = useState(false);
  const selectedDateRef = useRef(selectedDate);
  const aiRequestRef = useRef(0);
  selectedDateRef.current = selectedDate;

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      repository.getProfile(),
      repository.getDaily(selectedDate),
      repository.listMeals(selectedDate),
      repository.listDaily("", 28),
      repository.getReport(selectedDate),
      desktopApi.secrets.status("deepseek_api_key").catch(() => false),
      repository.getXiaomiDay(selectedDate),
    ]).then(([nextProfile, nextDaily, meals, logs, nextReport, keyAvailable, source]) => {
      if (!active) return;
      setProfile(nextProfile);
      setDaily(nextDaily);
      setMealDrafts(mealsToDrafts(meals));
      setSavedSignature(JSON.stringify([nextDaily, mealsToDrafts(meals)]));
      setXiaomiDay(source);
      setRecentLogs(logs);
      setReport(nextReport);
      setHasDeepSeekKey(keyAvailable);
    }).catch((error) => {
      if (active) onNotice(error instanceof Error ? error.message : "无法读取健康记录");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [onNotice, repository, selectedDate, syncRevision]);

  const meals = useMemo(() => draftsToMeals(selectedDate, mealDrafts), [mealDrafts, selectedDate]);
  const analysis = useMemo(() => analyzeHealthDay(profile, daily, meals), [daily, meals, profile]);
  const sleepEstimate = calculateSleepMinutes(daily.sleepStart, daily.sleepEnd, daily.awakeMinutes);
  const trend = useMemo(() => summarizeRecent(recentLogs, today), [recentLogs, today]);
  const profileBmi = calculateBmi(profile.currentWeightKg, profile.heightCm);
  const targetBmi = calculateBmi(profile.targetWeightKg, profile.heightCm);

  async function saveDay(event?: FormEvent) {
    event?.preventDefault();
    setSaving(true);
    try {
      const { daily: savedDaily } = await saveHealthDay(repository, daily, meals);
      setDaily(savedDaily);
      setSavedSignature(JSON.stringify([savedDaily, mealDrafts]));
      const refreshed = await repository.listDaily("", 28);
      setRecentLogs(refreshed);
      onChanged();
      onNotice(`${selectedDate} 的健康记录已保存。`);
      return savedDaily;
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "健康记录保存失败");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const saved = await repository.saveProfile(profile);
      setProfile(saved);
      onChanged();
      onNotice("健康档案已保存在本机。 ");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "健康档案保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function generateAiAdvice() {
    if (aiBusy) return;
    const requestId = ++aiRequestRef.current;
    const requestDate = selectedDate;
    setAiPanelOpen(true);
    setAiBusy(true);
    setAiStage("先保存并整理今天的记录…");
    try {
      const savedDaily = await saveDay();
      if (!savedDaily) {
        if (requestId === aiRequestRef.current) setAiStage("");
        return;
      }
      if (!hasDeepSeekKey) throw new Error("尚未配置 DeepSeek API Key，请前往“设置 → AI 与模型”后重试。 ");
      const model = await resolveAvailableDeepSeekModel(
        "healthAdvice",
        desktopApi.deepseek.apiModels,
        () => setAiStage("正在读取 DeepSeek 可用模型…"),
      );
      const input = buildHealthAiInput({
        date: requestDate,
        profile,
        daily: savedDaily,
        meals,
        recentLogs: [savedDaily, ...recentLogs.filter((item) => item.date !== savedDaily.date)],
      });
      setAiStage("正在通过 DeepSeek API 生成健康建议…");
      const response = await desktopApi.deepseek.healthAdvice({ model, input });
      const answer = formatHealthAiAdviceMarkdown(validateHealthAiAdviceContent(response.content));
      const savedReport = await repository.saveReport({ date: requestDate, content: answer, generatedAt: "" });
      if (requestId !== aiRequestRef.current || selectedDateRef.current !== requestDate) return;
      setReport(savedReport);
      setReportOpen(true);
      setAiStage("");
      onChanged();
      onNotice(`AI 健康建议已通过 ${response.model} 生成并保存。`);
    } catch (error) {
      if (requestId === aiRequestRef.current) {
        setAiStage(error instanceof Error ? error.message : "AI 建议生成失败");
      }
    } finally {
      if (requestId === aiRequestRef.current) setAiBusy(false);
    }
  }

  function selectDate(date: string) {
    if (!date || date === selectedDate || aiBusy || saving || sourceBusy || photoSaving) return;
    selectedDateRef.current = date;
    setReport(null);
    setMealAdviceOpen(false);
    setAiPanelOpen(false);
    setReportOpen(false);
    setLoading(true);
    setSelectedDate(date);
  }

  if (loading) {
    return <section className="health-page workspace-scroll"><div className="health-loading">正在读取本机健康记录…</div></section>;
  }

  return (
    <section className="health-page workspace-scroll">
      <header className="health-hero">
        <div>
          <span>生活方式记录</span>
          <h1>健康</h1>
          <p>用少量手动记录看清睡眠、活动与饮食节奏，不替代专业医疗判断。</p>
        </div>
        <ThemeSticker section="health" placement="health-hero" />
        <nav aria-label="健康页面">
          <button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}>今日记录</button>
          <button className={tab === "trends" ? "active" : ""} onClick={() => setTab("trends")}>近期趋势</button>
          <button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>我的档案</button>
        </nav>
      </header>

      <XiaomiHealthPanel repository={repository} date={selectedDate} daily={daily} dirty={dirty} onChanged={onChanged} onNotice={onNotice} />

      {tab === "today" && <>
        <div className="health-date-row">
          <label><span>记录日期</span><input type="date" max={today} value={selectedDate} disabled={aiBusy || saving || sourceBusy || photoSaving} onChange={(event) => selectDate(event.target.value)} /></label>
          <span>{selectedDate === today ? "今天" : "历史记录"} · 可手动记录或从小米同步</span>
        </div>

        <form className="health-layout" inert={sourceBusy || photoSaving} aria-busy={sourceBusy || photoSaving} onSubmit={(event) => void saveDay(event)}>
          <div className="health-entry-column">
            <section className="health-card">
              <CardTitle eyebrow="01" title="睡眠与状态" subtitle="填写入睡和起床时间后自动估算时长，也可以手动修正" />
              <div className="health-field-grid four">
                <SleepDurationField value={daily.sleepMinutes} onChange={(value) => setDaily({ ...daily, sleepMinutes: value })} />
                <NumberOrTimeField label="入睡" type="time" value={daily.sleepStart} onChange={(value) => setDaily((current) => updateSleepClock(current, "sleepStart", value))} />
                <NumberOrTimeField label="起床" type="time" value={daily.sleepEnd} onChange={(value) => setDaily((current) => updateSleepClock(current, "sleepEnd", value))} />
                <NumberField label="睡眠感受" suffix="/ 5" value={daily.sleepQuality} min={1} max={5} onChange={(value) => setDaily({ ...daily, sleepQuality: value })} />
              </div>
              <p className="health-inline-result">当前采用：<strong>{formatSleepDuration(analysis.sleepMinutes)}</strong><span>{xiaomiDay?.latest.sleep && !xiaomiDay.sleepLocked && daily.sleepMinutes !== null && daily.sleepMinutes === xiaomiDay.latest.sleep.sleepMinutes ? "小米报告的睡眠时长" : sleepEstimate !== null && daily.sleepMinutes === sleepEstimate ? "由起止时间估算；夜间清醒不一定能反映在内" : daily.sleepMinutes !== null ? "手动修正的时长" : sleepEstimate !== null ? "由起止时间估算" : ""}</span></p>
            </section>

            <section className="health-card">
              <CardTitle eyebrow="02" title="活动与体重" subtitle="这里只记结果，不代替专业运动软件" />
              <div className="health-field-grid four">
                <NumberField label="今天步数" suffix="步" value={daily.steps} min={0} max={200000} onChange={(value) => setDaily({ ...daily, steps: value })} />
                <NumberField label="额外活动" suffix="分钟" value={daily.activityMinutes} min={0} max={1440} onChange={(value) => setDaily({ ...daily, activityMinutes: value })} />
                <NumberField label="今日体重" suffix="kg" value={daily.weightKg} min={25} max={400} step={0.1} onChange={(value) => setDaily({ ...daily, weightKg: value })} />
                <NumberField label="精神状态" suffix="/ 5" value={daily.energyLevel} min={1} max={5} onChange={(value) => setDaily({ ...daily, energyLevel: value })} />
              </div>
              <label className="health-wide-field"><span>补充活动（可选）</span><input value={daily.activityNote} onChange={(event) => setDaily({ ...daily, activityNote: event.target.value })} placeholder="例如：晚饭后散步 20 分钟" /></label>
            </section>

            <section className="health-card">
              <CardTitle eyebrow="03" title="今天吃了什么" subtitle="可手写，也可上传照片生成可编辑的餐食草稿" />
              <MealPhotoPanel repository={repository.mealPhotos} date={selectedDate} dirty={dirty} hasKey={hasDeepSeekKey} onSaving={setPhotoSaving} onConfirmed={async () => {
                const next = mealsToDrafts(await repository.listMeals(selectedDate));
                if (selectedDateRef.current !== selectedDate) { onChanged(); return; }
                setMealDrafts(next); setSavedSignature(JSON.stringify([daily, next])); onChanged();
              }} />
              <div className="health-meal-list">
                {healthMealSlots.map((slot) => <div className="health-meal-row" key={slot.value}>
                  <strong>{slot.label}</strong>
                  <input type="time" aria-label={`${slot.label}时间`} value={mealDrafts[slot.value].eatenAt} onChange={(event) => updateMeal(slot.value, "eatenAt", event.target.value, setMealDrafts)} />
                  <textarea rows={2} aria-label={`${slot.label}餐食记录`} value={mealDrafts[slot.value].description} onChange={(event) => updateMeal(slot.value, "description", event.target.value, setMealDrafts)} placeholder={mealPlaceholder(slot.value)} />
                </div>)}
              </div>
            </section>

            <section className="health-card">
              <CardTitle eyebrow="04" title="补充说明" subtitle="只写会影响今天判断的情况" />
              <textarea className="health-note" rows={3} value={daily.note} onChange={(event) => setDaily({ ...daily, note: event.target.value })} placeholder="例如：今天感冒、熬夜赶工、食欲明显变化……" />
            </section>

            <Button variant="primary" className="health-save" type="submit" disabled={saving}>{saving ? "正在保存…" : "保存当天记录"}</Button>
          </div>

          <aside className="health-analysis-column">
            <section className="health-card health-summary-card">
              <CardTitle eyebrow="本地分析" title="今天的节奏" subtitle="无需联网，随填写即时更新" />
              <div className="health-metrics">
                <Metric label="睡眠" value={formatSleepDuration(analysis.sleepMinutes)} />
                <Metric label="步数" value={daily.steps === null ? "未记录" : daily.steps.toLocaleString("zh-CN")} />
                <Metric label="餐食" value={`${analysis.recordedMealCount} 项`} />
                <Metric label="BMI" value={analysis.bmi === null ? "待补充" : `${analysis.bmi} · ${bmiBandLabel(analysis.bmiBand)}`} />
              </div>
              <ul className="health-observations">{analysis.observations.map((item) => <li key={item}>{item}</li>)}</ul>
              <div className="health-advice-disclosure">
                <div><strong>下一餐建议</strong><small>{analysis.nextMealBasis}{analysis.dietaryPreferencesApplied ? " · 已应用饮食偏好" : ""}</small></div>
                <Button variant="secondary" size="small" type="button" aria-expanded={mealAdviceOpen} onClick={() => setMealAdviceOpen((value) => !value)}>{mealAdviceOpen ? "收起" : "查看"}</Button>
              </div>
              {mealAdviceOpen && <div className="health-next-meal">{analysis.nextMealSuggestions.map((item) => <p key={item}>{item}</p>)}</div>}
              <p className="health-rule-note">基础规则采用中国成年人 BMI、7—8 小时睡眠与每日 6000—10000 步的公共健康参考，仅用于生活方式提示。</p>
            </section>

            <section className="health-card health-ai-launcher">
              <div className="health-ai-launcher-copy"><span aria-hidden="true">✨</span><div><strong>AI 健康建议</strong><small>{report ? `${formatReportTime(report.generatedAt)} 已生成` : "按需生成，不会自动上传"}</small></div></div>
              <div className="health-ai-launcher-actions">
                {report && <Button variant="primary" size="small" type="button" aria-haspopup="dialog" onClick={() => setReportOpen(true)}>查看建议</Button>}
                <Button variant="secondary" size="small" type="button" aria-expanded={aiPanelOpen} onClick={() => setAiPanelOpen((value) => !value)}>{aiPanelOpen ? "收起" : report ? "生成选项" : "了解更多"}</Button>
              </div>
            </section>
            {aiPanelOpen && <section className="health-card health-ai-card">
                <CardTitle eyebrow="AI 建议" title="结合档案和近 7 天记录" subtitle="由你决定何时调用，不会自动上传" />
                <p className="health-local-note">只有点击生成后，才会把本页档案、当天记录与近 7 天趋势通过 DeepSeek API 发送；调用会消耗 API 额度。</p>
                {!hasDeepSeekKey && <div className="health-ai-stage warning">尚未配置 DeepSeek API Key。<Button variant="secondary" type="button" onClick={onOpenAiSettings}>前往 AI 与模型设置</Button></div>}
                <Button variant="primary" type="button" className="health-ai-button" disabled={aiBusy || !hasDeepSeekKey} onClick={() => void generateAiAdvice()}>{aiBusy ? "正在生成…" : report ? "重新生成 AI 建议" : "生成 AI 健康建议"}</Button>
                {aiStage && <div className="health-ai-stage">{aiStage}</div>}
              </section>}
          </aside>
        </form>
      </>}

      {tab === "trends" && <div className="health-trends">
        <section className="health-trend-overview">
          <Metric label="近 7 天平均睡眠" value={trend.averageSleep === null ? "记录不足" : formatSleepDuration(trend.averageSleep)} />
          <Metric label="近 7 天平均步数" value={trend.averageSteps === null ? "记录不足" : `${trend.averageSteps.toLocaleString("zh-CN")} 步`} />
          <Metric label="近 28 天记录" value={`${recentLogs.length} 天`} />
          <Metric label="最近体重" value={trend.latestWeight === null ? "未记录" : `${trend.latestWeight} kg`} />
        </section>
        <section className="health-card health-history-card">
          <CardTitle eyebrow="近 28 天" title="记录趋势" subtitle="先看稳定变化，不评价单日波动" />
          {recentLogs.length ? <div className="health-history-table">
            <header><span>日期</span><span>睡眠</span><span>步数</span><span>体重</span><span>精神</span></header>
            {recentLogs.map((item) => <button key={item.date} onClick={() => { selectDate(item.date); setTab("today"); }}>
              <strong>{item.date}</strong>
              <span>{formatSleepDuration(resolveSleepMinutes(item))}</span>
              <span>{item.steps === null ? "—" : item.steps.toLocaleString("zh-CN")}</span>
              <span>{item.weightKg === null ? "—" : `${item.weightKg} kg`}</span>
              <span>{item.energyLevel === null ? "—" : `${item.energyLevel} / 5`}</span>
            </button>)}
          </div> : <div className="health-empty">保存第一天记录后，这里会逐渐形成趋势。</div>}
        </section>
      </div>}

      {tab === "profile" && <form className="health-profile" onSubmit={(event) => void saveProfile(event)}>
        <section className="health-card">
          <CardTitle eyebrow="基础信息" title="身体与目标" subtitle="用于 BMI 和长期建议，可留空不想提供的项目" />
          <div className="health-field-grid three">
            <NumberField label="年龄（仅限成人）" suffix="岁" value={profile.age} min={18} max={120} onChange={(value) => setProfile({ ...profile, age: value })} />
            <label><span>性别（可选）</span><SelectMenu label="性别" value={profile.sex} onChange={(value) => setProfile({ ...profile, sex: value as HealthProfile["sex"] })} options={[{ value: "unspecified", label: "不提供" }, { value: "female", label: "女" }, { value: "male", label: "男" }]} /></label>
            <NumberField label="身高" suffix="cm" value={profile.heightCm} min={100} max={250} step={0.1} onChange={(value) => setProfile({ ...profile, heightCm: value })} />
            <NumberField label="当前体重" suffix="kg" value={profile.currentWeightKg} min={25} max={400} step={0.1} onChange={(value) => setProfile({ ...profile, currentWeightKg: value })} />
            <NumberField label="目标体重" suffix="kg" value={profile.targetWeightKg} min={25} max={400} step={0.1} onChange={(value) => setProfile({ ...profile, targetWeightKg: value })} />
            <label><span>希望达到日期</span><input type="date" value={profile.targetDate} onChange={(event) => setProfile({ ...profile, targetDate: event.target.value })} /></label>
          </div>
          <div className="health-bmi-row"><Metric label="当前 BMI" value={profileBmi === null ? "待补充身高体重" : String(profileBmi)} /><Metric label="目标 BMI" value={targetBmi === null ? "待补充目标" : String(targetBmi)} /></div>
          {targetBmi !== null && targetBmi < 18.5 && <p className="health-profile-warning">目标 BMI 低于成人常用参考范围，建议先与医生或注册营养师确认目标。</p>}
        </section>

        <section className="health-card">
          <CardTitle eyebrow="饮食边界" title="偏好、忌口与需要留意的事" subtitle="AI 生成建议时会优先遵守这些信息" />
          <div className="health-text-grid">
            <label><span>饮食偏好</span><textarea rows={3} value={profile.dietPreferences} onChange={(event) => setProfile({ ...profile, dietPreferences: event.target.value })} placeholder="例如：偏家常菜、少油、做饭时间不超过 20 分钟" /></label>
            <label><span>不喜欢或主动避免</span><textarea rows={3} value={profile.avoidFoods} onChange={(event) => setProfile({ ...profile, avoidFoods: event.target.value })} placeholder="例如：不吃香菜、不喜欢太辣" /></label>
            <label><span>食物过敏</span><textarea rows={3} value={profile.allergies} onChange={(event) => setProfile({ ...profile, allergies: event.target.value })} placeholder="只填写已知过敏；没有可以留空" /></label>
            <label><span>健康相关备注</span><textarea rows={3} value={profile.healthNotes} onChange={(event) => setProfile({ ...profile, healthNotes: event.target.value })} placeholder="例如：医生交代的饮食限制、影响活动的身体情况" /></label>
          </div>
          <p className="health-local-note">档案默认只保存在当前设备；只有你主动点击“生成 AI 健康建议”时，相关内容才会通过 API 发送给 DeepSeek。</p>
        </section>
        <Button variant="primary" type="submit" className="health-save" disabled={saving}>{saving ? "正在保存…" : "保存我的档案"}</Button>
      </form>}
      {reportOpen && report && <HealthAdviceDialog report={report} onClose={() => setReportOpen(false)} />}
    </section>
  );
}

function HealthAdviceDialog({ report, onClose }: { report: HealthAiReport; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return <dialog ref={dialogRef} className="health-advice-dialog" aria-labelledby="health-advice-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="health-advice-header">
      <div><span>AI 健康建议 · {formatReportTime(report.generatedAt)}</span><h2 id="health-advice-title">{report.date} 的建议</h2><p>DeepSeek API · 基于生成时已保存的数据</p></div>
      <Button variant="ghost" iconOnly autoFocus aria-label="关闭健康建议" onClick={onClose}>×</Button>
    </header>
    <div className="health-advice-body" tabIndex={0} role="region" aria-label="健康建议正文"><MarkdownDocument body={report.content} /></div>
  </dialog>;
}

function CardTitle({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return <header className="health-card-title"><span>{eyebrow}</span><div><h2>{title}</h2><p>{subtitle}</p></div></header>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="health-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function NumberField({ label, suffix, value, min, max, step = 1, onChange }: {
  label: string;
  suffix: string;
  value: number | null;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number | null) => void;
}) {
  return <label><span>{label}</span><div className="health-number-input"><input type="number" min={min} max={max} step={step} value={value ?? ""} onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))} /><small>{suffix}</small></div></label>;
}

function SleepDurationField({ value, onChange }: { value: number | null; onChange: (value: number | null) => void }) {
  const canonicalValue = formatSleepDurationEntry(value);
  const [draft, setDraft] = useState(canonicalValue);
  useEffect(() => setDraft(canonicalValue), [canonicalValue]);

  function commit(nextDraft: string) {
    const parsed = parseSleepDurationEntry(nextDraft);
    if (parsed === null) {
      setDraft(canonicalValue);
      return;
    }
    setDraft(formatSleepDurationEntry(parsed));
    onChange(parsed === 0 ? null : parsed);
  }

  return <label><span>实际睡眠</span><div className="health-duration-input"><input
    type="text"
    inputMode="numeric"
    maxLength={5}
    aria-label="实际睡眠时长（时:分）"
    value={draft}
    placeholder="00:00"
    onFocus={(event) => event.currentTarget.select()}
    onChange={(event) => setDraft(event.target.value.replace(/[^\d:]/g, ""))}
    onBlur={() => commit(draft)}
    onKeyDown={(event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commit(event.currentTarget.value);
      event.currentTarget.blur();
    }}
  /><small>时 : 分</small></div></label>;
}

function NumberOrTimeField({ label, type, value, onChange }: { label: string; type: "time"; value: string; onChange: (value: string) => void }) {
  return <label><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.currentTarget.value)} /></label>;
}

function updateMeal(slot: HealthMealSlot, field: "eatenAt" | "description", value: string, setDrafts: React.Dispatch<React.SetStateAction<MealDraft>>) {
  setDrafts((current) => ({ ...current, [slot]: { ...current[slot], [field]: value } }));
}

function mealsToDrafts(meals: HealthMeal[]) {
  const drafts = structuredClone(emptyMealDraft);
  meals.forEach((meal) => { drafts[meal.slot] = { eatenAt: meal.eatenAt, description: meal.description }; });
  return drafts;
}

function draftsToMeals(date: string, drafts: MealDraft): HealthMeal[] {
  return healthMealSlots.map(({ value }) => ({ date, slot: value, eatenAt: drafts[value].eatenAt, description: drafts[value].description, updatedAt: "" }));
}

function mealPlaceholder(slot: HealthMealSlot) {
  if (slot === "breakfast") return "例如：燕麦牛奶、煮鸡蛋";
  if (slot === "lunch") return "例如：米饭、番茄炒蛋、清炒青菜";
  if (slot === "dinner") return "例如：杂粮饭、清蒸鱼、西兰花";
  return "例如：苹果、酸奶；没有可留空";
}

function summarizeRecent(logs: HealthDailyLog[], today: string) {
  const sevenDaysAgo = shiftDate(today, -6);
  const recent = logs.filter((item) => item.date >= sevenDaysAgo && item.date <= today);
  const sleep = recent.map(resolveSleepMinutes).filter((value): value is number => value !== null);
  const steps = recent.map((item) => item.steps).filter((value): value is number => value !== null);
  const latestWeight = logs.find((item) => item.weightKg !== null)?.weightKg ?? null;
  return {
    averageSleep: sleep.length ? Math.round(sleep.reduce((sum, value) => sum + value, 0) / sleep.length) : null,
    averageSteps: steps.length ? Math.round(steps.reduce((sum, value) => sum + value, 0) / steps.length) : null,
    latestWeight,
  };
}

function shiftDate(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(year, month - 1, day);
  value.setDate(value.getDate() + days);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function formatReportTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "已保存";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
