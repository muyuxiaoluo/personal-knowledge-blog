export const OBSERVED_GENERATION_STABILITY_MS = 600;
export const FALLBACK_GENERATION_STABILITY_MS = 6_000;

export function isAiResponseSettled(input: {
  generating: boolean;
  changed: boolean;
  hasGenerated: boolean;
  observedGenerating: boolean;
  stableForMs: number;
}) {
  if (input.generating || !input.changed || !input.hasGenerated) return false;
  const requiredStability = input.observedGenerating
    ? OBSERVED_GENERATION_STABILITY_MS
    : FALLBACK_GENERATION_STABILITY_MS;
  return input.stableForMs >= requiredStability;
}

export function isMoreCompleteAiAnswer(local: string, official: string, legacyOfficial?: string) {
  if (local === official) return false;
  // Only repair a lossy saved formula when the old serializer reproduces it exactly.
  if (legacyOfficial && local === legacyOfficial) return true;
  const normalize = (value: string) => value
    .replace(/&#8203;|&ZeroWidthSpace;|\u200b/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[\w+-]*\n?/g, "")
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "")
    .replace(/^\s*(?:[-+*]|\d+\.)\s+/gm, "")
    .replace(/[`*_>#~|]/g, "")
    .replace(/\s+/g, "")
    .trim();
  const localText = normalize(local);
  const officialText = normalize(official);
  return Boolean(localText && officialText.length >= localText.length && officialText.startsWith(localText));
}

export function shouldConfirmAiConversationDeletion(messageCount: number) {
  return messageCount > 0;
}
