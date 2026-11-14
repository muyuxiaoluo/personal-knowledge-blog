import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheDeepSeekModels,
  DEFAULT_DEEPSEEK_MODEL_SETTINGS,
  loadDeepSeekModelSettings,
  resolveAvailableDeepSeekModel,
  resolveDeepSeekModel,
  saveDeepSeekModelSettings,
} from "../app/ai-model-settings";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("uses the agreed DeepSeek defaults and feature overrides", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  const settings = loadDeepSeekModelSettings();
  assert.deepEqual(settings, DEFAULT_DEEPSEEK_MODEL_SETTINGS);
  assert.equal(resolveDeepSeekModel("projectCreate", settings), "deepseek-flash");
  assert.equal(resolveDeepSeekModel("projectReplan", settings), "deepseek-flash");
  assert.equal(resolveDeepSeekModel("nextAction", settings), "deepseek-flash");
  assert.equal(resolveDeepSeekModel("globalPlanning", settings), "deepseek-flash");
  assert.equal(resolveDeepSeekModel("financeReport", settings), "deepseek-flash");
  assert.equal(resolveDeepSeekModel("healthAdvice", settings), "deepseek-flash");
});

test("prefers an explicit feature model and keeps preferences device-local", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  const saved = saveDeepSeekModelSettings({
    defaultModel: "deepseek-flash",
    overrides: { projectCreate: "", projectReplan: "", nextAction: "deepseek-custom", globalPlanning: "", financeReport: "", healthAdvice: "" },
  });
  assert.equal(resolveDeepSeekModel("nextAction", saved), "deepseek-custom");
  assert.equal(resolveDeepSeekModel("financeReport", saved), "deepseek-flash");
  assert.equal(resolveDeepSeekModel("healthAdvice", saved), "deepseek-flash");
});

test("migrates retired V4 web-era aliases to the unified model", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  const saved = saveDeepSeekModelSettings({
    defaultModel: "deepseek-v4-flash",
    overrides: { projectCreate: "deepseek-v4-pro", projectReplan: "deepseek-v4-flash-vision-exp", nextAction: "", globalPlanning: "", financeReport: "", healthAdvice: "" },
  });
  assert.equal(saved.defaultModel, "deepseek-flash");
  assert.equal(saved.overrides.projectCreate, "deepseek-flash");
  assert.equal(saved.overrides.projectReplan, "deepseek-flash");
});

test("resolves an available model through one shared cache path", async () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  let fetches = 0;
  const fetchModels = async () => {
    fetches += 1;
    return [{ id: "deepseek-flash", object: "model", ownedBy: "deepseek" }];
  };

  assert.equal(await resolveAvailableDeepSeekModel("financeReport", fetchModels), "deepseek-flash");
  assert.equal(await resolveAvailableDeepSeekModel("healthAdvice", fetchModels), "deepseek-flash");
  assert.equal(fetches, 1);

  cacheDeepSeekModels([{ id: "another-model", object: "model", ownedBy: "deepseek" }]);
  await assert.rejects(
    () => resolveAvailableDeepSeekModel("nextAction", fetchModels),
    /当前不可用/,
  );
});
