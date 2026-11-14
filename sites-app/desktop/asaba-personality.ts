export type AsabaMomentKind = "cuddle" | "cheer" | "sleepy" | "pat" | "thinking" | "spin" | "curious" | "work" | "result";
export type AsabaMoment = { mood: string; text: string; accent: "warm" | "bright" | "soft"; symbol: string };

const moments: Record<AsabaMomentKind, AsabaMoment[]> = {
  cuddle: [
    { mood: "cuddle", text: "你忙你的，小兔子先借我抱一下。", accent: "warm", symbol: "♡" },
    { mood: "cuddle", text: "今天的陪伴搭子，还有这只小兔子。", accent: "warm", symbol: "♡" },
    { mood: "cuddle", text: "小兔子说，它也想摸摸你的头。", accent: "warm", symbol: "✧" },
  ],
  cheer: [
    { mood: "cheer", text: "气势这块，我和小兔子包了。", accent: "bright", symbol: "✦" },
    { mood: "cheer", text: "灵感有时候就差一个小小的加油。", accent: "bright", symbol: "✧" },
  ],
  sleepy: [
    { mood: "sleepy", text: "我才没有打瞌睡……只是眨得慢一点。", accent: "soft", symbol: "☾" },
    { mood: "sleepy", text: "月亮上班了，我和小兔子也还在。", accent: "soft", symbol: "☾" },
  ],
  pat: [
    { mood: "cheer", text: "好啦，呆毛要翘起来啦。", accent: "warm", symbol: "♡" },
    { mood: "cheer", text: "小兔子也排队了，它也想被摸摸。", accent: "warm", symbol: "♡" },
  ],
  thinking: [{ mood: "thinking", text: "歪头加载中……让我想想。", accent: "soft", symbol: "⋯" }],
  spin: [{ mood: "spin", text: "跟着小节拍，跳一小段。", accent: "soft", symbol: "♪" }],
  curious: [{ mood: "thinking", text: "这页慢慢看，我先歪头陪一会儿。", accent: "soft", symbol: "?" }],
  work: [{ mood: "cuddle", text: "灵感先接住，计划可以晚点再说。", accent: "warm", symbol: "✧" }],
  result: [{ mood: "cheer", text: "有份委托结果回来了，等你有空看看。", accent: "bright", symbol: "✦" }],
};

export function asabaMoment(kind: AsabaMomentKind, turn: number): AsabaMoment {
  const choices = moments[kind];
  return choices[Math.abs(Math.trunc(turn)) % choices.length];
}

export function asabaPlayKind(turn: number, hour: number): AsabaMomentKind {
  const choices: AsabaMomentKind[] = hour >= 22 || hour < 6
    ? ["cuddle", "sleepy", "cheer", "thinking", "spin"]
    : ["cuddle", "cheer", "thinking", "spin", "sleepy"];
  return choices[Math.abs(Math.trunc(turn)) % choices.length];
}

export function asabaMaySpeak(options: { automatic: boolean; enabled: boolean; quiet: boolean; visible: boolean; now: number; lastAt: number }) {
  if (!options.visible) return false;
  if (!options.automatic) return true;
  return options.enabled && !options.quiet && options.now - options.lastAt >= 120_000;
}
