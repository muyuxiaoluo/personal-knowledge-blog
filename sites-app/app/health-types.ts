export type HealthSex = "female" | "male" | "unspecified";

export type HealthProfile = {
  age: number | null;
  sex: HealthSex;
  heightCm: number | null;
  currentWeightKg: number | null;
  targetWeightKg: number | null;
  targetDate: string;
  dietPreferences: string;
  avoidFoods: string;
  allergies: string;
  healthNotes: string;
  updatedAt: string;
};

export type HealthDailyLog = {
  date: string;
  sleepMinutes: number | null;
  sleepStart: string;
  sleepEnd: string;
  awakeMinutes: number | null;
  sleepQuality: number | null;
  energyLevel: number | null;
  steps: number | null;
  weightKg: number | null;
  activityMinutes: number | null;
  activityNote: string;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type HealthMealSlot = "breakfast" | "lunch" | "dinner" | "snack";

export type HealthMeal = {
  date: string;
  slot: HealthMealSlot;
  eatenAt: string;
  description: string;
  updatedAt: string;
};

export type HealthAiReport = {
  date: string;
  content: string;
  generatedAt: string;
};

export type HealthAiAdviceContent = {
  summary: string;
  facts: string[];
  sleepAdvice: string[];
  activityAdvice: string[];
  nextMeal: {
    focus: string;
    options: Array<{
      title: string;
      foods: string[];
      reason: string;
    }>;
  };
  attention: string[];
  limitations: string[];
};

export const emptyHealthProfile: HealthProfile = {
  age: null,
  sex: "unspecified",
  heightCm: null,
  currentWeightKg: null,
  targetWeightKg: null,
  targetDate: "",
  dietPreferences: "",
  avoidFoods: "",
  allergies: "",
  healthNotes: "",
  updatedAt: "",
};

export function emptyHealthDailyLog(date: string): HealthDailyLog {
  return {
    date,
    sleepMinutes: null,
    sleepStart: "",
    sleepEnd: "",
    awakeMinutes: null,
    sleepQuality: null,
    energyLevel: null,
    steps: null,
    weightKg: null,
    activityMinutes: null,
    activityNote: "",
    note: "",
    createdAt: "",
    updatedAt: "",
  };
}

export const healthMealSlots: Array<{ value: HealthMealSlot; label: string }> = [
  { value: "breakfast", label: "早餐" },
  { value: "lunch", label: "午餐" },
  { value: "dinner", label: "晚餐" },
  { value: "snack", label: "加餐" },
];
