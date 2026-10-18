import type { DeepSeekApiFeature, DeepSeekModel, DeepSeekModelSettings } from "./ai-api-types";

const SETTINGS_KEY = "mind-garden:deepseek-api-model-settings:v1";
const MODELS_KEY = "mind-garden:deepseek-api-models:v1";
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000;

export const DEFAULT_DEEPSEEK_MODEL_SETTINGS: DeepSeekModelSettings = {
  defaultModel: "deepseek-flash",
  overrides: {
    projectCreate: "",
    projectReplan: "",
    nextAction: "",
    financeReport: "",
    healthAdvice: "",
  },
};

export function loadDeepSeekModelSettings(): DeepSeekModelSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Partial<DeepSeekModelSettings>;
    const overrides: Partial<DeepSeekModelSettings["overrides"]> = parsed.overrides ?? {};
    return {
      defaultModel: normalizedModel(parsed.defaultModel) || DEFAULT_DEEPSEEK_MODEL_SETTINGS.defaultModel,
      overrides: {
        projectCreate: normalizedModel(overrides.projectCreate),
        projectReplan: normalizedModel(overrides.projectReplan),
        nextAction: normalizedModel(overrides.nextAction),
        financeReport: normalizedModel(overrides.financeReport),
        healthAdvice: normalizedModel(overrides.healthAdvice),
      },
    };
  } catch {
    return structuredClone(DEFAULT_DEEPSEEK_MODEL_SETTINGS);
  }
}

export function saveDeepSeekModelSettings(settings: DeepSeekModelSettings) {
  const normalized: DeepSeekModelSettings = {
    defaultModel: normalizedModel(settings.defaultModel) || DEFAULT_DEEPSEEK_MODEL_SETTINGS.defaultModel,
    overrides: {
      projectCreate: normalizedModel(settings.overrides.projectCreate),
      projectReplan: normalizedModel(settings.overrides.projectReplan),
      nextAction: normalizedModel(settings.overrides.nextAction),
      financeReport: normalizedModel(settings.overrides.financeReport),
      healthAdvice: normalizedModel(settings.overrides.healthAdvice),
    },
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function resolveDeepSeekModel(feature: DeepSeekApiFeature, settings = loadDeepSeekModelSettings()) {
  return settings.overrides[feature] || settings.defaultModel;
}

export async function resolveAvailableDeepSeekModel(
  feature: DeepSeekApiFeature,
  fetchModels: () => Promise<DeepSeekModel[]>,
  onRefresh?: () => void,
) {
  const selected = resolveDeepSeekModel(feature);
  let cached = loadCachedDeepSeekModels();
  if (!cached?.fresh) {
    onRefresh?.();
    const models = await fetchModels();
    cacheDeepSeekModels(models);
    cached = { models, fresh: true };
  }
  if (!cached.models.some((model) => model.id === selected)) {
    throw new Error(`模型 ${selected} 当前不可用，请前往“设置 → AI 与模型”重新选择。`);
  }
  return selected;
}

export function loadCachedDeepSeekModels(): { models: DeepSeekModel[]; fresh: boolean } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODELS_KEY) || "null") as { models?: DeepSeekModel[]; fetchedAt?: string } | null;
    if (!parsed?.models?.length || !parsed.fetchedAt) return null;
    return { models: parsed.models, fresh: Date.now() - new Date(parsed.fetchedAt).getTime() < MODEL_CACHE_TTL };
  } catch {
    return null;
  }
}

export function cacheDeepSeekModels(models: DeepSeekModel[]) {
  localStorage.setItem(MODELS_KEY, JSON.stringify({ models, fetchedAt: new Date().toISOString() }));
}

function normalizedModel(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(value.trim())) return "";
  const model = value.trim();
  if (["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro"].includes(model)) {
    return "deepseek-flash";
  }
  return model;
}
