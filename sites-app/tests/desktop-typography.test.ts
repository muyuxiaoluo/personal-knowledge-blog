import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_FONT_PRESETS,
  loadDesktopFontPreset,
  saveDesktopFontPreset,
} from "../desktop/DesktopTypography";

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  let savedKey = "";
  return {
    getItem: () => value,
    setItem: (key: string, nextValue: string) => {
      savedKey = key;
      value = nextValue;
    },
    read: () => ({ key: savedKey, value }),
  };
}

test("desktop typography exposes the three user-facing font presets", () => {
  assert.deepEqual(DESKTOP_FONT_PRESETS.map((preset) => preset.id), ["modern", "wenkai", "serif"]);
});

test("desktop typography keeps the current style by default and rejects unknown values", () => {
  assert.equal(loadDesktopFontPreset(memoryStorage()), "modern");
  assert.equal(loadDesktopFontPreset(memoryStorage("unknown-font")), "modern");
});

test("desktop typography saves and restores a selected preset", () => {
  const storage = memoryStorage();
  saveDesktopFontPreset("wenkai", storage);
  assert.deepEqual(storage.read(), { key: "life-strategy.font-preset", value: "wenkai" });
  assert.equal(loadDesktopFontPreset(storage), "wenkai");
});
