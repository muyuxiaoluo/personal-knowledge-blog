import "./styles/dashboard.css";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { eventOccursOn, morningBriefRefreshSlot, nextCalendarOccurrences, normalizeAiHighlightKeywords, rainVerdict, zonedIsoMinute } from "../app/dashboard-helpers";
import type {
  AiBriefSnapshot,
  CalendarEvent,
  CitySuggestion,
  DashboardCache,
  DashboardModuleKey,
  DashboardPreferences,
  ExternalSourceInput,
  MorningBriefSnapshot,
  WeatherSnapshot,
} from "../app/dashboard-types";
import type { DashboardRepository } from "../app/data/dashboard-repository";
import { officialHolidayDays, officialHolidayOn, officialHolidaySource } from "../app/official-holidays";
import { Button, SelectMenu } from "./DesktopControls";
import { desktopApi } from "./integrationApi";
import { HomeAiHighlights } from "./HomeAiHighlights";

type SharedProps = {
  today: string;
  repository: DashboardRepository;
  preferences: DashboardPreferences;
  onNotice: (message: string) => void;
};

export function MorningOverview({
  today,
  repository,
  preferences,
  events,
  onSavePreferences,
  onSaveEvent,
  onDeleteEvent,
  onNotice,
}: SharedProps & {
  events: CalendarEvent[];
  onSavePreferences: (preferences: DashboardPreferences) => Promise<void>;
  onSaveEvent: (event: CalendarEvent) => Promise<CalendarEvent>;
  onDeleteEvent: (id: string) => Promise<void>;
}) {
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [weatherCache, setWeatherCache] = useState<DashboardCache<WeatherSnapshot> | null>(null);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [weatherError, setWeatherError] = useState("");
  const weatherRequestActive = useRef(false);
  const [cityOpen, setCityOpen] = useState(false);
  const [calendarViewOpen, setCalendarViewOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarDate, setCalendarDate] = useState(today);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const location = preferences.location;
  const weatherKey = location ? `weather:${location.latitude.toFixed(4)}:${location.longitude.toFixed(4)}` : "";

  const refreshWeather = useCallback(async (manual = false) => {
    if (!location || !weatherKey || !isTauri() || weatherRequestActive.current) return;
    weatherRequestActive.current = true;
    setWeatherBusy(true);
    setWeatherError("");
    try {
      const cached = await repository.getCache<WeatherSnapshot>(weatherKey);
      const result = await desktopApi.dashboard.weather(location, cached?.etag ?? "");
      if (result.notModified && cached) {
        await repository.touchCache(weatherKey, result.fetchedAt, result.maxAgeSeconds);
        const touched = { ...cached, fetchedAt: result.fetchedAt, expiresAt: expiresAt(result.fetchedAt, result.maxAgeSeconds) };
        setWeather(cached.value);
        setWeatherCache(touched);
      } else if (result.value) {
        const saved = await repository.saveCache(weatherKey, result.value, result.etag, result.fetchedAt, result.maxAgeSeconds);
        setWeather(result.value);
        setWeatherCache(saved);
      }
      if (manual) onNotice("天气已经更新。 ");
    } catch (error) {
      setWeatherError(errorMessage(error, "天气暂时无法更新"));
      if (manual) onNotice(errorMessage(error, "天气暂时无法更新"));
    } finally {
      weatherRequestActive.current = false;
      setWeatherBusy(false);
    }
  }, [location, onNotice, repository, weatherKey]);

  useEffect(() => {
    let active = true;
    if (!location || !weatherKey) {
      setWeather(null);
      setWeatherCache(null);
      setWeatherError("");
      return;
    }
    void repository.getCache<WeatherSnapshot>(weatherKey).then((cached) => {
      if (!active) return;
      setWeather(cached?.value ?? null);
      setWeatherCache(cached);
      if (!cached || isExpired(cached)) void refreshWeather();
    });
    return () => { active = false; };
  }, [location, refreshWeather, repository, weatherKey]);

  useEffect(() => {
    const refreshIfNeeded = () => {
      if (document.visibilityState !== "visible") return;
      if (!weatherCache || isExpired(weatherCache)) void refreshWeather();
    };
    window.addEventListener("focus", refreshIfNeeded);
    const timer = window.setInterval(refreshIfNeeded, 60_000);
    return () => {
      window.removeEventListener("focus", refreshIfNeeded);
      window.clearInterval(timer);
    };
  }, [refreshWeather, weatherCache]);

  if (!preferences.modules.weather && !preferences.modules.calendar) return null;

  return (
    <div className="morning-overview-grid">
      {preferences.modules.weather && (
        <WeatherCard
          snapshot={weather}
          cache={weatherCache}
          busy={weatherBusy}
          error={weatherError}
          onChooseCity={() => setCityOpen(true)}
          onRefresh={() => void refreshWeather(true)}
        />
      )}
      {preferences.modules.calendar && (
        <CalendarCard
          today={today}
          events={events}
          onOpenCalendar={() => setCalendarViewOpen(true)}
          onManage={(date, event) => {
            setCalendarDate(date);
            setEditingEvent(event ?? null);
            setCalendarOpen(true);
          }}
        />
      )}
      {cityOpen && (
        <CityPickerModal
          current={location}
          onClose={() => setCityOpen(false)}
          onSelect={async (next) => {
            await onSavePreferences({ ...preferences, location: next });
            setCityOpen(false);
          }}
        />
      )}
      {calendarOpen && (
        <CalendarManagerModal
          initialDate={calendarDate}
          initialEvent={editingEvent}
          events={events}
          onClose={() => setCalendarOpen(false)}
          onSave={onSaveEvent}
          onDelete={onDeleteEvent}
          onNotice={onNotice}
        />
      )}
      {calendarViewOpen && (
        <CalendarOverviewModal
          today={today}
          events={events}
          onClose={() => setCalendarViewOpen(false)}
          onManage={(date, event) => {
            setCalendarViewOpen(false);
            setCalendarDate(date);
            setEditingEvent(event ?? null);
            setCalendarOpen(true);
          }}
        />
      )}
    </div>
  );
}

export function MorningInformation({ today, repository, preferences, onSavePreferences, onSaveSource, onNotice }: SharedProps & {
  onSavePreferences: (preferences: DashboardPreferences) => Promise<void>;
  onSaveSource: (input: ExternalSourceInput) => Promise<boolean>;
}) {
  const [ai, setAi] = useState<AiBriefSnapshot | null>(null);
  const [aiCache, setAiCache] = useState<DashboardCache<AiBriefSnapshot> | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [brief, setBrief] = useState<MorningBriefSnapshot | null>(null);
  const [briefCache, setBriefCache] = useState<DashboardCache<MorningBriefSnapshot> | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState("");
  const [briefOpen, setBriefOpen] = useState(false);
  const [keywordOpen, setKeywordOpen] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());
  const aiRequestActive = useRef(false);
  const briefRequestActive = useRef(false);
  const briefAttemptSlot = useRef("");

  const refreshAi = useCallback(async (manual = false) => {
    if (!preferences.modules.aiHot || !isTauri() || aiRequestActive.current) return;
    aiRequestActive.current = true;
    setAiBusy(true);
    try {
      const cached = await repository.getCache<AiBriefSnapshot>("aihot:brief");
      const refreshAll = manual || cached?.value.warnings?.length || cached?.value.attribution.url !== "https://aihot.news";
      const result = await desktopApi.dashboard.aiBrief(refreshAll ? "" : cached?.etag ?? "");
      if (result.notModified && cached) {
        await repository.touchCache("aihot:brief", result.fetchedAt, result.maxAgeSeconds);
        setAi(cached.value);
        setAiCache({ ...cached, fetchedAt: result.fetchedAt, expiresAt: expiresAt(result.fetchedAt, result.maxAgeSeconds) });
      } else if (result.value) {
        const saved = await repository.saveCache("aihot:brief", result.value, result.etag, result.fetchedAt, result.maxAgeSeconds);
        setAi(result.value);
        setAiCache(saved);
      }
      setAiError("");
      if (manual) onNotice(result.value?.warnings?.length ? `AI 动态已更新，部分内容暂不可用：${result.value.warnings.join("；")}` : "AI 热点已经更新。 ");
    } catch (error) {
      setAiError(errorMessage(error, "AI 热点暂时无法更新"));
      if (manual) onNotice(errorMessage(error, "AI 热点暂时无法更新"));
    } finally {
      aiRequestActive.current = false;
      setAiBusy(false);
    }
  }, [onNotice, preferences.modules.aiHot, repository]);

  const refreshBrief = useCallback(async (manual = false) => {
    if (!preferences.modules.morningBrief || !isTauri() || briefRequestActive.current) return;
    briefRequestActive.current = true;
    const clock = beijingClock();
    briefAttemptSlot.current = morningBriefRefreshSlot(brief?.date ?? null, clock.date, clock.hour) || `${clock.date}:current`;
    setBriefBusy(true);
    setBriefError("");
    try {
      const dates = morningCandidateDates();
      let found: DashboardCache<MorningBriefSnapshot> | null = null;
      for (const date of dates) {
        const key = `morning-brief:${date}`;
        const cached = await repository.getCache<MorningBriefSnapshot>(key);
        const result = await desktopApi.dashboard.morningBrief(date, cached?.etag ?? "");
        if (result.notModified && cached) {
          await repository.touchCache(key, result.fetchedAt, result.maxAgeSeconds);
          found = { ...cached, fetchedAt: result.fetchedAt, expiresAt: expiresAt(result.fetchedAt, result.maxAgeSeconds) };
          break;
        }
        if (result.value) {
          found = await repository.saveCache(key, result.value, result.etag, result.fetchedAt, result.maxAgeSeconds);
          await repository.saveCache("morning-brief:latest", result.value, result.etag, result.fetchedAt, result.maxAgeSeconds);
          break;
        }
      }
      if (found) {
        setBrief(found.value);
        setBriefCache(found);
      }
      if (manual) onNotice(found ? "每日早报已经更新。 " : "今天的早报尚未发布。 ");
    } catch (error) {
      setBriefError(errorMessage(error, "每日早报暂时无法更新"));
      if (manual) onNotice(errorMessage(error, "每日早报暂时无法更新"));
    } finally {
      briefRequestActive.current = false;
      setBriefBusy(false);
    }
  }, [brief?.date, onNotice, preferences.modules.morningBrief, repository]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      repository.getCache<AiBriefSnapshot>("aihot:brief"),
      repository.getCache<MorningBriefSnapshot>("morning-brief:latest"),
    ]).then(([cachedAi, cachedBrief]) => {
      if (!active) return;
      setAi(cachedAi?.value ?? null);
      setAiCache(cachedAi);
      setBrief(cachedBrief?.value ?? null);
      setBriefCache(cachedBrief);
      if (preferences.modules.aiHot && (!cachedAi || isExpired(cachedAi))) void refreshAi();
      const clock = beijingClock();
      const slot = morningBriefRefreshSlot(cachedBrief?.value.date ?? null, clock.date, clock.hour);
      if (preferences.modules.morningBrief && slot && slot !== briefAttemptSlot.current) void refreshBrief();
    });
    return () => { active = false; };
  }, [preferences.modules.aiHot, preferences.modules.morningBrief, refreshAi, refreshBrief, repository, today]);

  useEffect(() => {
    const refreshOnFocus = () => {
      if (document.visibilityState !== "visible") return;
      if (!aiCache || isExpired(aiCache)) void refreshAi();
      const clock = beijingClock();
      const slot = morningBriefRefreshSlot(brief?.date ?? null, clock.date, clock.hour);
      if (slot && slot !== briefAttemptSlot.current) void refreshBrief();
    };
    window.addEventListener("focus", refreshOnFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (preferences.modules.aiHot && (!aiCache || isExpired(aiCache))) void refreshAi();
      const clock = beijingClock();
      const slot = morningBriefRefreshSlot(brief?.date ?? null, clock.date, clock.hour);
      if (preferences.modules.morningBrief && slot && slot !== briefAttemptSlot.current) void refreshBrief();
    }, 60_000);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      window.clearInterval(timer);
    };
  }, [aiCache, brief, preferences.modules.aiHot, preferences.modules.morningBrief, refreshAi, refreshBrief]);

  if (!preferences.modules.aiHot && !preferences.modules.morningBrief) return null;

  async function saveItem(item: AiBriefSnapshot["items"][number]) {
    const saved = await onSaveSource({
      url: item.originalUrl || item.aihotUrl,
      title: item.title,
      summary: item.summary,
      sourceLabel: item.sourceName || "AIHOT",
    });
    if (saved) setSavedIds((current) => new Set(current).add(item.id));
  }

  return (
    <div className="morning-information-grid">
      {preferences.modules.aiHot && (
        <section className="workspace-card morning-ai-card" data-home-tile data-news-density="short">
          <header className="morning-card-heading">
            <div><span>AI 动态 · {ai?.items.length ?? 0} 条</span><strong>关注速览</strong></div>
            <nav className="morning-information-actions">
              <Button variant="ghost" size="small" type="button" disabled={aiBusy} onClick={() => void refreshAi(true)}>{aiBusy ? "更新中…" : "刷新"}</Button>
              <Button variant="ghost" size="small" type="button" onClick={() => setKeywordOpen(true)}>关注词{preferences.aiHighlightKeywords.length ? ` ${preferences.aiHighlightKeywords.length}` : ""}</Button>
              {preferences.modules.morningBrief && <button className="morning-brief-header-entry" disabled={briefBusy} onClick={() => brief ? setBriefOpen(true) : void refreshBrief(true)}><b>60s 早报</b><small>{brief ? `${formatShortDate(brief.date)} · ${brief.news.length} 条` : briefBusy ? "获取中…" : "点击获取"}</small></button>}
            </nav>
          </header>
          <HomeAiHighlights snapshot={ai} keywords={preferences.aiHighlightKeywords} savedIds={savedIds} busy={aiBusy} error={aiError} onRefresh={() => void refreshAi(true)} onOpenExternal={openExternal} onSave={saveItem} sourceStatus={<MorningSourceStatus cache={aiCache} error={aiError} warning={ai?.warnings?.join("；")} autoLabel="每 30 分钟自动更新" name={ai?.attribution.name || "AIHOT"} url={ai?.attribution.url || "https://aihot.news"} />} />
          <MorningSourceStatus cache={aiCache} error={aiError} warning={ai?.warnings?.join("；")} autoLabel="每 30 分钟自动更新" name={ai?.attribution.name || "AIHOT"} url={ai?.attribution.url || "https://aihot.news"} />
        </section>
      )}
      {preferences.modules.morningBrief && !preferences.modules.aiHot && (
        <section className="workspace-card morning-news-card" data-home-tile data-news-density="short">
          <header className="morning-card-heading"><div><span>每日早报</span><strong>{brief ? `${formatShortDate(brief.date)} · 60 秒读懂世界` : "60 秒读懂世界"}</strong></div><Button variant="ghost" size="small" type="button" disabled={briefBusy} onClick={() => void refreshBrief(true)}>{briefBusy ? "更新中…" : "刷新"}</Button></header>
          {brief ? <button className="morning-brief-launcher" onClick={() => setBriefOpen(true)}>
            <i>60″</i><span><b>{brief.news.length} 条新闻已经整理好</b><small>{brief.news[0]}</small><em>{brief.date === beijingClock().date ? "阅读今日早报" : "阅读最近一期"} →</em></span>
          </button> : <div className="morning-brief-empty"><MorningEmpty busy={briefBusy} error={briefError} label="暂时没有可显示的每日早报" /></div>}
          <MorningSourceStatus cache={briefCache} error={briefError} autoLabel="每天 8–11 点整点检查" name={brief?.attribution.name || "60s API"} url={brief?.sourceUrl || brief?.attribution.url || "https://60s-static-host.vercel.app"} />
        </section>
      )}
      {keywordOpen && <AiKeywordModal keywords={preferences.aiHighlightKeywords} onClose={() => setKeywordOpen(false)} onSave={async (keywords) => { await onSavePreferences({ ...preferences, aiHighlightKeywords: keywords }); onNotice(keywords.length ? `已保存 ${keywords.length} 个 AI 关注词。` : "已清空 AI 关注词。"); }} />}
      {briefOpen && brief && <MorningBriefModal brief={brief} cache={briefCache} error={briefError} busy={briefBusy} onRefresh={() => void refreshBrief(true)} onClose={() => setBriefOpen(false)} />}
    </div>
  );
}

export function DashboardSettingsSection({ preferences, onSave }: {
  preferences: DashboardPreferences;
  onSave: (preferences: DashboardPreferences) => Promise<void>;
}) {
  const [cityOpen, setCityOpen] = useState(false);
  const [busy, setBusy] = useState<DashboardModuleKey | "">("");
  const modules: Array<{ key: DashboardModuleKey; label: string; detail: string }> = [
    { key: "weather", label: "天气与降雨提醒", detail: "显示当前天气、三日预报和今天是否可能下雨" },
    { key: "calendar", label: "日历与重要日期", detail: "显示法定节假日、调休和你标记的重要日期" },
    { key: "aiHot", label: "AI 热点", detail: "读取 AIHOT 近 24 小时精选与 AI 日报" },
    { key: "morningBrief", label: "每日早报", detail: "读取最近一期 60 秒新闻摘要" },
  ];

  async function toggle(key: DashboardModuleKey) {
    setBusy(key);
    try {
      await onSave({ ...preferences, modules: { ...preferences.modules, [key]: !preferences.modules[key] } });
    } finally {
      setBusy("");
    }
  }

  return <section className="workspace-card settings-section settings-morning-section">
    <header><span>晨间首页</span><h2>天气、日历与资讯</h2><p>城市只保存到本地；可以随时关闭不需要的首页卡片。</p></header>
    <div className="settings-city-row"><div><strong>{preferences.location ? preferences.location.name : "尚未选择天气城市"}</strong><small>{preferences.location ? `${locationBreadcrumb(preferences.location) || preferences.location.country} · ${preferences.location.timezone}` : "不会读取 GPS，也不会通过 IP 猜测位置"}</small></div><Button variant="secondary" type="button" onClick={() => setCityOpen(true)}>{preferences.location ? "更换城市" : "选择城市"}</Button></div>
    <div className="settings-module-list">{modules.map((module) => <div key={module.key} className="settings-toggle-row"><button type="button" role="switch" aria-checked={preferences.modules[module.key]} disabled={Boolean(busy)} className={preferences.modules[module.key] ? "settings-switch on" : "settings-switch"} onClick={() => void toggle(module.key)}><i /></button><div><strong>{module.label}</strong><small>{module.detail}</small></div></div>)}</div>
    <p className="settings-provider-note">天气由 Open-Meteo 提供；AI 内容来自 AIHOT；综合早报来自 60s API。摘要仅作线索，重要事实请打开原文核对。</p>
    {cityOpen && <CityPickerModal current={preferences.location} onClose={() => setCityOpen(false)} onSelect={async (location) => { await onSave({ ...preferences, location }); setCityOpen(false); }} />}
  </section>;
}

function WeatherCard({ snapshot, cache, busy, error, onChooseCity, onRefresh }: {
  snapshot: WeatherSnapshot | null;
  cache: DashboardCache<WeatherSnapshot> | null;
  busy: boolean;
  error: string;
  onChooseCity: () => void;
  onRefresh: () => void;
}) {
  const verdict = snapshot ? rainVerdict(snapshot, zonedIsoMinute(new Date(), snapshot.location.timezone)) : null;
  return <section className="workspace-card morning-weather-card" data-home-tile>
    <header className="morning-card-heading"><div><span>今日天气</span><strong>{snapshot?.location.name || "选择你的城市"}</strong></div><nav>{snapshot && <Button variant="ghost" size="small" type="button" disabled={busy} onClick={onRefresh}>{busy ? "更新中…" : "刷新"}</Button>}<Button variant="ghost" size="small" type="button" onClick={onChooseCity}>{snapshot ? "换城市" : "选择城市"}</Button></nav></header>
    {snapshot ? <div className="weather-compact-body">
      <div className="weather-now"><i>{weatherIcon(snapshot.current.weatherCode, snapshot.current.isDay)}</i><div><strong>{Math.round(snapshot.current.temperature)}°</strong><span>{weatherLabel(snapshot.current.weatherCode)} · 体感 {Math.round(snapshot.current.apparentTemperature)}°</span></div></div>
      <aside className={`rain-verdict ${verdict?.tone}`}><b>{verdict?.label}</b><span>{verdict?.detail}</span><small>最高概率 {Math.round(verdict?.maxProbability ?? 0)}%</small></aside>
      <div className="weather-three-days">{snapshot.daily.map((day, index) => <article key={day.date}><span>{index === 0 ? "今天" : index === 1 ? "明天" : weekday(day.date)}</span><i>{weatherIcon(day.weatherCode, true)}</i><strong>{Math.round(day.temperatureMax)}° / {Math.round(day.temperatureMin)}°</strong><small>{Math.round(day.precipitationProbabilityMax)}%</small></article>)}</div>
    </div> : <div className="weather-setup"><i>⌖</i><span><strong>先选择城市或区县</strong><p>只保存所选地点的中心坐标，不读取你的精确位置。</p></span><Button variant="secondary" type="button" onClick={onChooseCity}>设置天气位置</Button>{error && <small>{error}</small>}</div>}
    {snapshot && <MorningSourceStatus cache={cache} error={error} autoLabel="每 45 分钟自动更新" name={snapshot.attribution.name} url={snapshot.attribution.url} />}
  </section>;
}

function CalendarCard({ today, events, onOpenCalendar, onManage }: { today: string; events: CalendarEvent[]; onOpenCalendar: () => void; onManage: (date: string, event?: CalendarEvent) => void }) {
  const upcoming = useMemo(() => combinedUpcoming(events, today), [events, today]);
  const holiday = officialHolidayOn(today);
  return <section className="workspace-card morning-calendar-card" data-home-tile>
    <header className="morning-card-heading"><div><span>今日日历</span><strong>{formatCalendarToday(today)}</strong></div><nav><Button variant="ghost" size="small" type="button" onClick={onOpenCalendar}>查看月历</Button><Button variant="ghost" size="small" type="button" onClick={() => onManage(today)}>＋ 标记</Button></nav></header>
    <div className="calendar-compact-body"><div className="calendar-today-tile"><span>{weekday(today)}</span><strong>{Number(today.slice(8))}</strong><small>{holiday ? `${holiday.name} · ${holiday.kind === "workday" ? "调休上班" : "休息"}` : "普通工作日"}</small></div><CalendarUpcoming upcoming={upcoming} onManage={onManage} /></div>
    <footer className="calendar-source"><Button wrap variant="ghost" size="small" type="button" onClick={() => void openExternal(officialHolidaySource.url)}>法定节假日来源：{officialHolidaySource.label} ↗</Button></footer>
  </section>;
}

function CityPickerModal({ current, onClose, onSelect }: { current: DashboardPreferences["location"]; onClose: () => void; onSelect: (location: CitySuggestion) => Promise<void> }) {
  const [query, setQuery] = useState(current?.name ?? "");
  const [results, setResults] = useState<CitySuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useDialogEscape(onClose);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const next = await desktopApi.dashboard.searchCities(query.trim());
      setResults(next);
      if (!next.length) setMessage("没有找到这个地点，请尝试输入城市、区县，或补充省份名称。");
    } catch (error) {
      setMessage(errorMessage(error, "城市查询失败"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="morning-modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="morning-modal city-picker-modal" role="dialog" aria-modal="true" aria-label="选择天气位置"><header><div><span>天气位置</span><h2>选择城市或区县</h2></div><Button variant="secondary" size="small" iconOnly type="button" onClick={onClose} aria-label="关闭">×</Button></header><form onSubmit={search}><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：成都、武侯区、成都, 四川" /><Button variant="secondary" type="submit" disabled={busy || !query.trim()}>{busy ? "查询中…" : "搜索"}</Button></form><p className="city-privacy-note">结果按行政层级和人口排序；同一路径只保留一项。只保存中心坐标，不读取 GPS。</p><div className="city-results">{results.map((city) => <button key={`${city.providerLabel}-${city.id}`} onClick={() => void onSelect(city)}><span><strong>{city.name}<em>{city.kindLabel}</em></strong><small>{locationBreadcrumb(city) || city.country}</small></span><time>{city.timezone === "auto" ? "跟随位置" : city.timezone}</time></button>)}</div>{message && <p className="morning-modal-message" role="status">{message}</p>}<footer className="city-search-attribution"><span>城市：Open-Meteo / GeoNames</span><Button wrap variant="secondary" type="button" onClick={() => void openExternal("https://www.openstreetmap.org/copyright")}>区县：© OpenStreetMap contributors ↗</Button></footer></section></div>;
}

function CalendarOverviewModal({ today, events, onClose, onManage }: {
  today: string;
  events: CalendarEvent[];
  onClose: () => void;
  onManage: (date: string, event?: CalendarEvent) => void;
}) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const cells = useMemo(() => calendarCells(month), [month]);
  const upcoming = useMemo(() => combinedUpcoming(events, today), [events, today]);
  useDialogEscape(onClose);
  return <div className="morning-modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="morning-modal calendar-overview-modal" role="dialog" aria-modal="true" aria-label="查看月历"><header><div><span>重要日期</span><h2>{Number(month.slice(0, 4))} 年 {Number(month.slice(5))} 月</h2></div><Button variant="secondary" size="small" iconOnly type="button" onClick={onClose} aria-label="关闭">×</Button></header>
    <div className="calendar-overview-toolbar"><Button variant="ghost" size="small" type="button" onClick={() => setMonth(shiftMonth(month, -1))}>‹ 上月</Button><Button variant="ghost" size="small" type="button" onClick={() => setMonth(today.slice(0, 7))}>回到本月</Button><Button variant="ghost" size="small" type="button" onClick={() => setMonth(shiftMonth(month, 1))}>下月 ›</Button></div>
    <div className="mini-calendar"><div className="calendar-weekdays">{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-days">{cells.map((date, index) => {
      if (!date) return <i key={`blank-${index}`} />;
      const holiday = officialHolidayOn(date);
      const custom = events.filter((event) => eventOccursOn(event, date));
      return <button key={date} className={`${date === today ? "today" : ""} ${holiday?.kind || ""} ${custom.length ? "custom" : ""}`} title={[holiday?.name, ...custom.map((event) => event.title)].filter(Boolean).join(" · ")} onClick={() => onManage(date, custom[0])}><span>{Number(date.slice(8))}</span>{holiday && <small>{holiday.kind === "workday" ? "班" : "休"}</small>}{custom.length > 0 && <b style={{ background: custom[0].color }} />}</button>;
    })}</div></div>
    <CalendarUpcoming upcoming={upcoming} onManage={onManage} />
    <footer className="calendar-overview-footer"><Button variant="secondary" type="button" onClick={() => onManage(today)}>＋ 标记重要日期</Button><Button wrap variant="ghost" size="small" type="button" onClick={() => void openExternal(officialHolidaySource.url)}>节假日来源：{officialHolidaySource.label} ↗</Button></footer>
  </section></div>;
}

type UpcomingItem = ReturnType<typeof combinedUpcoming>[number];

function CalendarUpcoming({ upcoming, onManage }: { upcoming: UpcomingItem[]; onManage: (date: string, event?: CalendarEvent) => void }) {
  return <div className="calendar-upcoming"><strong>接下来</strong>{upcoming.length ? upcoming.map((item) => <button type="button" key={`${item.kind}-${item.date}-${item.title}`} className={item.event ? "editable" : ""} onClick={() => item.event ? onManage(item.date, item.event) : undefined}><i className={item.kind} style={item.color ? { background: item.color } : undefined} /><span><b>{item.title}</b><small>{formatShortDate(item.date)} · {remainingLabel(item.daysRemaining)}</small></span></button>) : <p>近期还没有重要日期。</p>}</div>;
}

function MorningBriefModal({ brief, cache, error, busy, onRefresh, onClose }: {
  brief: MorningBriefSnapshot;
  cache: DashboardCache<MorningBriefSnapshot> | null;
  error: string;
  busy: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  useDialogEscape(onClose);
  return <div className="morning-modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="morning-modal morning-brief-modal" role="dialog" aria-modal="true" aria-label="每日早报"><header><div><span>每日早报 · {formatShortDate(brief.date)}</span><h2>60 秒读懂世界</h2></div><nav><Button variant="secondary" type="button" disabled={busy} onClick={onRefresh}>{busy ? "更新中…" : "刷新"}</Button><Button variant="secondary" size="small" iconOnly type="button" onClick={onClose} aria-label="关闭">×</Button></nav></header>
    <div className="morning-news-sheet"><ol>{brief.news.map((item, index) => <li key={`${brief.date}-${index}`}><i>{String(index + 1).padStart(2, "0")}</i><span>{item}</span></li>)}</ol>{brief.tip && <blockquote>{brief.tip}</blockquote>}{brief.date !== beijingClock().date && <p className="brief-date-warning">今天的早报尚未发布，当前显示最近一期。</p>}</div>
    <MorningSourceStatus cache={cache} error={error} autoLabel="每天 8–11 点整点检查" name={brief.attribution.name} url={brief.sourceUrl || brief.attribution.url} />
  </section></div>;
}

function AiKeywordModal({ keywords, onClose, onSave }: {
  keywords: string[];
  onClose: () => void;
  onSave: (keywords: string[]) => Promise<void>;
}) {
  const [value, setValue] = useState(keywords.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const normalized = useMemo(() => normalizeAiHighlightKeywords(value), [value]);
  useDialogEscape(onClose);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(normalized);
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError, "关注词保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="morning-modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="morning-modal ai-keyword-modal" role="dialog" aria-modal="true" aria-label="设置 AI 关注词"><header><div><span>AI 动态</span><h2>设置关注词</h2></div><Button variant="secondary" size="small" iconOnly type="button" onClick={onClose} aria-label="关闭">×</Button></header><form onSubmit={submit}>
    <label><span>每行一个，也可以用逗号分隔</span><textarea autoFocus maxLength={360} value={value} onChange={(event) => setValue(event.target.value)} placeholder={"新模型\n模型发布\n开源"} /></label>
    <p>关注词会匹配标题、摘要、推荐理由和分类。首页最多显示 3 条命中资讯，其余内容可点击“查看全部动态”阅读。</p>
    <div className="ai-keyword-preview"><strong>{normalized.length}/12 个关注词</strong><div>{normalized.length ? normalized.map((keyword) => <span key={keyword}>{keyword}</span>) : <small>尚未设置关注词</small>}</div></div>
    {error && <p className="morning-modal-message" role="status">{error}</p>}
    <footer><Button variant="secondary" type="button" onClick={() => setValue("")}>清空</Button><Button variant="secondary" type="button" onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={busy}>{busy ? "保存中…" : "保存关注词"}</Button></footer>
  </form></section></div>;
}

function CalendarManagerModal({ initialDate, initialEvent, events, onClose, onSave, onDelete, onNotice }: {
  initialDate: string;
  initialEvent: CalendarEvent | null;
  events: CalendarEvent[];
  onClose: () => void;
  onSave: (event: CalendarEvent) => Promise<CalendarEvent>;
  onDelete: (id: string) => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [draft, setDraft] = useState(() => initialEvent ? { ...initialEvent } : emptyCalendarEvent(initialDate));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useDialogEscape(onClose);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const saved = await onSave(draft);
      setDraft(saved);
      setConfirmDelete(false);
    } catch (error) {
      onNotice(errorMessage(error, "重要日期保存失败"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft.id) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy(true);
    try {
      await onDelete(draft.id);
      setDraft(emptyCalendarEvent(initialDate));
      setConfirmDelete(false);
    } catch (error) {
      onNotice(errorMessage(error, "重要日期删除失败"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="morning-modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="morning-modal calendar-manager-modal" role="dialog" aria-modal="true" aria-label="管理重要日期"><header><div><span>日历</span><h2>{draft.id ? "编辑重要日期" : "标记重要日期"}</h2></div><Button variant="secondary" size="small" iconOnly type="button" onClick={onClose} aria-label="关闭">×</Button></header><div className="calendar-manager-body"><form onSubmit={submit}>
    <label><span>名称</span><input autoFocus maxLength={60} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例如：家人生日" /></label>
    <div className="calendar-form-grid"><label><span>重复方式</span><SelectMenu label="重复方式" value={draft.recurrence} onChange={(value) => setDraft({ ...draft, recurrence: value as CalendarEvent["recurrence"] })} options={[{ value: "once", label: "仅这一次" }, { value: "yearlyGregorian", label: "每年公历" }, { value: "yearlyLunar", label: "每年农历" }]} /></label>{draft.recurrence !== "yearlyLunar" ? <label><span>日期</span><input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label> : <><label><span>农历月</span><input type="number" min={1} max={12} value={draft.lunarMonth ?? 1} onChange={(event) => setDraft({ ...draft, lunarMonth: Number(event.target.value) })} /></label><label><span>农历日</span><input type="number" min={1} max={30} value={draft.lunarDay ?? 1} onChange={(event) => setDraft({ ...draft, lunarDay: Number(event.target.value) })} /></label></>}</div>
    {draft.recurrence === "yearlyLunar" && <label className="calendar-check"><input type="checkbox" checked={draft.lunarLeapMonth} onChange={(event) => setDraft({ ...draft, lunarLeapMonth: event.target.checked })} /><span>只在对应的农历闰月出现</span></label>}
    <div className="calendar-form-grid"><label><span>标记颜色</span><input type="color" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></label><label><span>提前提醒天数</span><input type="number" min={0} max={365} value={draft.reminderDays} onChange={(event) => setDraft({ ...draft, reminderDays: Number(event.target.value) })} /></label></div>
    <label className="calendar-check"><input type="checkbox" checked={draft.important} onChange={(event) => setDraft({ ...draft, important: event.target.checked })} /><span>作为重要日期显示在首页</span></label>
    <label><span>备注</span><textarea maxLength={500} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="可选：需要提前准备什么？" /></label>
    <footer><Button variant="secondary" type="button" onClick={onClose}>关闭</Button>{draft.id && <Button type="button" variant="danger" disabled={busy} onClick={() => void remove()}>{confirmDelete ? "再次点击确认删除" : "删除"}</Button>}<Button variant="primary" type="submit" disabled={busy || !draft.title.trim()}>{busy ? "保存中…" : "保存日期"}</Button></footer>
  </form><aside><strong>已标记的日期</strong><div>{events.length ? events.map((item) => <button key={item.id} className={item.id === draft.id ? "active" : ""} onClick={() => { setDraft({ ...item }); setConfirmDelete(false); }}><i style={{ background: item.color }} /><span><b>{item.title}</b><small>{calendarEventDescription(item)}</small></span></button>) : <p>还没有自定义重要日期。</p>}</div></aside></div></section></div>;
}

function MorningSourceStatus<T>({ cache, error, warning, autoLabel, name, url }: { cache: DashboardCache<T> | null; error: string; warning?: string; autoLabel?: string; name: string; url: string }) {
  const issue = error ? `更新失败${cache ? "，显示缓存" : ""}：${error}` : warning ? `部分内容未更新：${warning}` : "";
  return <footer className="morning-source-status" title={autoLabel}><span className={issue ? "stale" : ""} role={issue ? "status" : undefined}>{issue && <>{issue}<br /></>}{formatCacheTime(cache)}</span><div>{autoLabel && <em>{autoLabel}</em>}<Button wrap variant="ghost" size="small" type="button" aria-label={`数据来源：${name}`} onClick={() => void openExternal(url)}>{name} ↗</Button></div></footer>;
}

function MorningEmpty({ busy, error, label }: { busy: boolean; error: string; label: string }) {
  return <div className="morning-empty"><i>{busy ? "↻" : "○"}</i><strong>{busy ? "正在获取…" : label}</strong>{error && <p>{error}</p>}</div>;
}

function useDialogEscape(onClose: () => void) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
}

function emptyCalendarEvent(date: string): CalendarEvent {
  return { id: "", title: "", date, recurrence: "once", lunarMonth: 1, lunarDay: 1, lunarLeapMonth: false, important: true, color: "#c87557", reminderDays: 3, notes: "", createdAt: "", updatedAt: "" };
}

function calendarEventDescription(event: CalendarEvent) {
  if (event.recurrence === "once") return formatShortDate(event.date);
  if (event.recurrence === "yearlyGregorian") return `每年 ${Number(event.date.slice(5, 7))} 月 ${Number(event.date.slice(8, 10))} 日`;
  return `每年农历${event.lunarLeapMonth ? "闰" : ""}${event.lunarMonth}月${event.lunarDay}日`;
}

function calendarCells(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const values: Array<string | null> = Array.from({ length: offset }, () => null);
  for (let day = 1; day <= count; day += 1) values.push(`${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  while (values.length % 7) values.push(null);
  return values;
}

function shiftMonth(month: string, amount: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + amount, 1));
  return date.toISOString().slice(0, 7);
}

function combinedUpcoming(events: CalendarEvent[], today: string) {
  const custom = nextCalendarOccurrences(events.filter((event) => event.important), today, 12).map((item) => ({ kind: "custom", title: item.event.title, date: item.date, daysRemaining: item.daysRemaining, color: item.event.color, event: item.event }));
  const official = officialHolidayDays.filter((item, index, all) => item.date >= today && (item.kind === "workday" || index === 0 || all[index - 1].name !== item.name || dayGap(all[index - 1].date, item.date) !== 1)).slice(0, 8).map((item) => ({ kind: item.kind, title: item.kind === "workday" ? `${item.name} · 上班` : item.name, date: item.date, daysRemaining: dayGap(today, item.date), color: "", event: undefined }));
  return [...custom, ...official].sort((left, right) => left.date.localeCompare(right.date)).slice(0, 3);
}

function dayGap(from: string, to: string) {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
}

function remainingLabel(days: number) {
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  return `${days} 天后`;
}

function weatherIcon(code: number, isDay: boolean) {
  if (code === 0) return isDay ? "☀" : "☾";
  if (code <= 3) return "☁";
  if (code <= 48) return "≋";
  if (code <= 67 || (code >= 80 && code <= 82)) return "☂";
  if (code <= 77 || code === 85 || code === 86) return "❄";
  if (code >= 95) return "ϟ";
  return "☁";
}

function weatherLabel(code: number) {
  if (code === 0) return "晴";
  if (code <= 3) return code === 1 ? "大致晴朗" : "多云";
  if (code <= 48) return "有雾";
  if (code <= 57) return "毛毛雨";
  if (code <= 67) return "下雨";
  if (code <= 77) return "降雪";
  if (code <= 82) return "阵雨";
  if (code <= 86) return "阵雪";
  if (code >= 95) return "雷暴";
  return "天气变化";
}

function weekday(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function expiresAt(fetchedAt: string, maxAgeSeconds: number) {
  return new Date(new Date(fetchedAt).getTime() + maxAgeSeconds * 1000).toISOString();
}

function isExpired(cache: DashboardCache<unknown>) {
  return new Date(cache.expiresAt).getTime() <= Date.now();
}

function formatCacheTime(cache: DashboardCache<unknown> | null) {
  if (!cache) return "尚未更新";
  const value = new Date(cache.fetchedAt);
  if (Number.isNaN(value.getTime())) return "更新时间未知";
  return `更新于 ${value.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

function formatShortDate(value: string) {
  const match = value.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${Number(match[1])}月${Number(match[2])}日` : value;
}

function formatCalendarToday(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${Number(match[2])} 月 ${Number(match[3])} 日 · ${weekday(value)}` : value;
}

function locationBreadcrumb(location: DashboardPreferences["location"] | CitySuggestion) {
  if (!location) return "";
  const name = location.name.trim().toLowerCase();
  const seen = new Set([name]);
  return [location.admin4, location.admin3, location.admin2, location.admin1, location.country]
    .map((value) => value?.trim() ?? "")
    .filter((value) => {
      const key = value.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(" · ");
}

function morningCandidateDates() {
  const { date, hour } = beijingClock();
  const start = new Date(`${date}T00:00:00+08:00`);
  if (hour < 8) start.setUTCDate(start.getUTCDate() - 1);
  return Array.from({ length: 3 }, (_, index) => {
    const candidate = new Date(start);
    candidate.setUTCDate(candidate.getUTCDate() - index);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(candidate);
  });
}

function beijingClock() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${read("year")}-${read("month")}-${read("day")}`, hour: Number(read("hour")) };
}

async function openExternal(url: string) {
  if (!url) return;
  if (isTauri()) { await openUrl(url); return; }
  window.open(url, "_blank", "noopener,noreferrer");
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}
