declare module "lunar-javascript" {
  export type LunarSolarDate = {
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    toYmd(): string;
  };

  export type LunarDate = {
    getSolar(): LunarSolarDate;
  };

  export const Lunar: {
    fromYmd(year: number, month: number, day: number): LunarDate;
  };
}
