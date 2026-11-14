import type { HealthMealSlot } from "./health-types";

export type MealPhoto = {
  id: string; date: string; slot: HealthMealSlot; eatenAt: string;
  capturedAt: string; imageDataUrl: string; description: string; reviewed: boolean; createdAt: string;
};
export const MAX_MEAL_PHOTO_URL = 90_000;
export function validMealPhotoImage(value: string) {
  return value.length <= MAX_MEAL_PHOTO_URL && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value);
}
export function mealSlotAt(time: string): HealthMealSlot {
  const hour = Number(time.slice(0, 2));
  return hour >= 5 && hour < 10 ? "breakfast" : hour >= 10 && hour < 15 ? "lunch" : hour >= 17 && hour < 22 ? "dinner" : "snack";
}
export function photoDateTime(file: Pick<File, "lastModified">, exif = "") {
  if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(exif)) {
    const stamp = exif.slice(0, 10).replaceAll(":", "-") + "T" + exif.slice(11);
    const day = Date.parse(stamp.slice(0, 10));
    if (Number.isFinite(Date.parse(stamp)) && Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === stamp.slice(0, 10)) return { date: stamp.slice(0, 10), time: stamp.slice(11, 16), capturedAt: stamp, estimated: false };
  }
  const date = new Date(file.lastModified || Date.now());
  const stamp = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  return { date: stamp.slice(0, 10), time: stamp.slice(11, 16), capturedAt: stamp, estimated: true };
}

// Read DateTimeOriginal from JPEG EXIF before canvas compression removes metadata.
export function jpegCaptureTime(buffer: ArrayBuffer): string {
  const view = new DataView(buffer);
  try {
    if (view.getUint16(0) !== 0xffd8) return "";
    let segment = 2;
    while (segment + 4 < view.byteLength) {
      const marker = view.getUint16(segment), size = view.getUint16(segment + 2);
      if (marker === 0xffda || marker === 0xffd9 || size < 2) break;
      const start = segment + 4;
      if (marker === 0xffe1 && view.getUint32(start) === 0x45786966 && view.getUint16(start + 4) === 0) {
        const base = start + 6, end = segment + 2 + size;
        const little = view.getUint16(base) === 0x4949;
        if ((!little && view.getUint16(base) !== 0x4d4d) || view.getUint16(base + 2, little) !== 42) return "";
        const readDirectory = (offset: number, nested = false): string => {
          const at = base + offset;
          if (at < base || at + 2 > Math.min(end, view.byteLength)) return "";
          const count = Math.min(view.getUint16(at, little), 512);
          let fallback = "";
          for (let i = 0; i < count; i++) {
            const entry = at + 2 + i * 12;
            if (entry + 12 > Math.min(end, view.byteLength)) break;
            const tag = view.getUint16(entry, little), value = view.getUint32(entry + 8, little);
            if (tag === 0x8769 && !nested) { const result = readDirectory(value, true); if (result) return result; }
            if ((tag === 0x9003 || tag === 0x132) && view.getUint16(entry + 2, little) === 2 && view.getUint32(entry + 4, little) === 20 && base + value + 20 <= Math.min(end, view.byteLength)) {
              const text = new TextDecoder().decode(new Uint8Array(buffer, base + value, 19));
              if (tag === 0x9003) return text;
              fallback = text;
            }
          }
          return fallback;
        };
        return readDirectory(view.getUint32(base + 4, little));
      }
      segment += 2 + size;
    }
  } catch { /* Missing/truncated EXIF falls back to a time the user can adjust. */ }
  return "";
}

export async function prepareMealPhoto(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 30 * 1024 * 1024) throw new Error("请选择 30 MB 以内的 JPG、PNG 或 WebP 照片。");
  const bytes = await file.arrayBuffer();
  const id = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), v => v.toString(16).padStart(2, "0")).join("");
  const timing = photoDateTime(file, jpegCaptureTime(bytes));
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height) throw new Error("照片无法打开。");
    const canvas = document.createElement("canvas");
    let imageDataUrl = "";
    for (const edge of [960, 720, 512, 384]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("当前设备无法处理照片。");
      context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.65, 0.45]) {
        imageDataUrl = canvas.toDataURL("image/jpeg", quality);
        if (validMealPhotoImage(imageDataUrl)) return { id, imageDataUrl, ...timing };
      }
    }
    throw new Error("照片压缩后仍过大，请换一张照片。");
  } finally { bitmap.close(); }
}
