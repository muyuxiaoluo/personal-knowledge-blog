export type FontPresetId = "modern" | "wenkai" | "serif";

export type DesktopFontPresetDefinition = {
  id: FontPresetId;
  label: string;
  description: string;
  preview: string;
};

export const DESKTOP_FONT_PRESETS: readonly DesktopFontPresetDefinition[] = [
  {
    id: "modern",
    label: "清晰现代",
    description: "保留熟悉的系统字体，适合高密度信息与日常操作",
    preview: "今天也要稳稳向前",
  },
  {
    id: "wenkai",
    label: "温柔文楷",
    description: "更轻松亲切，适合角色主题、行动标题与个人笔记",
    preview: "今天也要稳稳向前",
  },
  {
    id: "serif",
    label: "书卷宋体",
    description: "端正而有阅读感，适合长文、探索资料与复盘内容",
    preview: "今天也要稳稳向前",
  },
] as const;

const fontPresetIds = new Set<FontPresetId>(DESKTOP_FONT_PRESETS.map((preset) => preset.id));
const fontPresetStorageKey = "life-strategy.font-preset";

type FontPresetStorage = Pick<Storage, "getItem" | "setItem">;

function isFontPresetId(value: string | null): value is FontPresetId {
  return value !== null && fontPresetIds.has(value as FontPresetId);
}

export function loadDesktopFontPreset(storage: FontPresetStorage = localStorage): FontPresetId {
  const stored = storage.getItem(fontPresetStorageKey);
  return isFontPresetId(stored) ? stored : "modern";
}

export function saveDesktopFontPreset(fontPresetId: FontPresetId, storage: FontPresetStorage = localStorage) {
  storage.setItem(fontPresetStorageKey, fontPresetId);
}
