export const DEFAULT_THEME_PALETTES = [
  { id: "original", label: "原有", primary: "#376253" },
  { id: "violet", label: "暮紫", primary: "#5954aa" },
  { id: "blue", label: "湖蓝", primary: "#2b6697" },
  { id: "green", label: "松绿", primary: "#357862" },
] as const;

export type DefaultThemePalette = typeof DEFAULT_THEME_PALETTES[number]["id"];
const paletteStorageKey = "life-strategy.default-theme-palette";
type PaletteStorage = Pick<Storage, "getItem" | "setItem">;

export function loadDefaultThemePalette(storage: PaletteStorage = localStorage): DefaultThemePalette {
  const stored = storage.getItem(paletteStorageKey);
  return DEFAULT_THEME_PALETTES.find((palette) => palette.id === stored)?.id ?? "original";
}

export function saveDefaultThemePalette(palette: DefaultThemePalette, storage: PaletteStorage = localStorage) {
  storage.setItem(paletteStorageKey, palette);
}
