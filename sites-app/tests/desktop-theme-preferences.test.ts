import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_THEME_PALETTES, loadDefaultThemePalette, saveDefaultThemePalette } from "../app/desktop-theme-preferences";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("new and invalid default palette preferences preserve the original appearance", () => {
  const saved = storage();
  assert.equal(loadDefaultThemePalette(saved), "original");
  saved.setItem("life-strategy.default-theme-palette", "unknown-palette");
  assert.equal(loadDefaultThemePalette(saved), "original");
});

test("each default palette persists independently of character theme changes", () => {
  const saved = storage();
  for (const palette of DEFAULT_THEME_PALETTES) {
    saveDefaultThemePalette(palette.id, saved);
    saved.setItem("life-strategy.theme-id", "roxy");
    assert.equal(loadDefaultThemePalette(saved), palette.id);
    saved.setItem("life-strategy.theme-id", "asuna");
    assert.equal(loadDefaultThemePalette(saved), palette.id);
    saved.setItem("life-strategy.theme-id", "default");
    assert.equal(loadDefaultThemePalette(saved), palette.id);
  }
});
