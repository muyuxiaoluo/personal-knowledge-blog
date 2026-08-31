import { type CSSProperties } from "react";
import asunaCharacter from "./assets/asuna-character-v1.webp";
import asunaChibiSticker from "./assets/asuna-chibi-sticker-v1.webp";
import roxyCharacter from "./assets/roxy-character-v1.webp";
import roxyChibiSticker from "./assets/roxy-chibi-sticker-v1.webp";
import roxyCheerSticker from "./assets/roxy-expressions/cheer.webp";
import roxyGoodNightSticker from "./assets/roxy-expressions/good-night.webp";
import roxyHardWorkSticker from "./assets/roxy-expressions/hard-work.webp";
import roxyPeekSticker from "./assets/roxy-expressions/peek.webp";
import roxyStudySticker from "./assets/roxy-expressions/study.webp";
import roxyThinkingSticker from "./assets/roxy-expressions/thinking.webp";
import roxyWelcomeSticker from "./assets/roxy-expressions/welcome.webp";

export type ThemeId = "default" | "roxy" | "asuna";

export type DesktopThemeDefinition = {
  id: ThemeId;
  label: string;
  description: string;
  characterImage: string | null;
  stickerImage: string | null;
  particleCount: number;
};

export const DESKTOP_THEMES: readonly DesktopThemeDefinition[] = [
  {
    id: "default",
    label: "默认",
    description: "安静清晰的工作台，不显示角色装饰",
    characterImage: null,
    stickerImage: null,
    particleCount: 0,
  },
  {
    id: "roxy",
    label: "洛琪希",
    description: "蓝紫星辉、魔法书与沉静的夜色",
    characterImage: roxyCharacter,
    stickerImage: roxyChibiSticker,
    particleCount: 10,
  },
  {
    id: "asuna",
    label: "亚丝娜",
    description: "象牙白、绯红与温暖的金色微光",
    characterImage: asunaCharacter,
    stickerImage: asunaChibiSticker,
    particleCount: 7,
  },
] as const;

const themeIds = new Set<ThemeId>(DESKTOP_THEMES.map((theme) => theme.id));
const themeStorageKey = "life-strategy.theme-id";
const legacyThemeStorageKey = "life-strategy.theme-mode";
const roxySectionStickers: Readonly<Record<string, string>> = {
  home: roxyWelcomeSticker,
  tasks: roxyStudySticker,
  projects: roxyCheerSticker,
  explore: roxyPeekSticker,
  inbox: roxyThinkingSticker,
  review: roxyHardWorkSticker,
  archive: roxyGoodNightSticker,
};

function isThemeId(value: string | null): value is ThemeId {
  return value !== null && themeIds.has(value as ThemeId);
}

export function loadDesktopTheme(storage: Storage = localStorage): ThemeId {
  const stored = storage.getItem(themeStorageKey);
  if (isThemeId(stored)) return stored;

  const legacy = storage.getItem(legacyThemeStorageKey);
  const migrated: ThemeId = legacy === "magic" || legacy === "immersive"
    ? "roxy"
    : "default";
  storage.setItem(themeStorageKey, migrated);
  return migrated;
}

export function saveDesktopTheme(themeId: ThemeId, storage: Storage = localStorage) {
  storage.setItem(themeStorageKey, themeId);
}

export function ThemeArtwork({ themeId, section, documentMode }: {
  themeId: ThemeId;
  section: string;
  documentMode: boolean;
}) {
  const theme = DESKTOP_THEMES.find((candidate) => candidate.id === themeId);
  if (!theme?.characterImage || documentMode) return null;
  const expressionSticker = theme.id === "roxy" ? roxySectionStickers[section] : null;
  const stickerImage = expressionSticker ?? theme.stickerImage;

  return (
    <div className="character-theme-layer" data-section={section} aria-hidden="true">
      <div className="character-theme-backdrop" />
      <div className="character-theme-particles magic-particles">
        {Array.from({ length: theme.particleCount }, (_, index) => {
          const style = {
            "--particle-x": `${(index * 37 + 11) % 96}%`,
            "--particle-y": `${(index * 53 + 7) % 92}%`,
            "--particle-size": `${2 + index % 4}px`,
          } as CSSProperties;
          return <i key={index} style={style} />;
        })}
      </div>
      <img className="character-theme-figure" src={theme.characterImage} alt="" draggable={false} />
      {stickerImage && (
        <div className={`character-theme-header-sticker${expressionSticker ? " is-expression" : ""}`}>
          {!expressionSticker && <span className="character-theme-prop prop-primary" />}
          <img src={stickerImage} alt="" draggable={false} />
          {!expressionSticker && <span className="character-theme-prop prop-secondary" />}
        </div>
      )}
    </div>
  );
}
