"""Prepare a generated 8 x 6 sheet for the desktop pet. Build-time only.

Requires Pillow, numpy and opencv-python-headless. Every pose uses ONE scale;
only the position of the planted feet is aligned. No per-frame fit-to-box.
"""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "node_modules/.cache/asaba-tools"))
import cv2
import numpy as np
from PIL import Image


def clean(cell):
    rgba = np.array(cell.convert("RGBA"))
    alpha = rgba[:, :, 3]
    count, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > 100).astype(np.uint8))
    if count < 2:
        raise ValueError("A sprite cell is empty")
    body = (labels == (1 + np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    nearby = cv2.dilate(body, np.ones((3, 3), np.uint8))
    rgba[:, :, 3] = (np.clip((alpha.astype(float) - 24) * 255 / 210, 0, 255) * nearby).astype(np.uint8)
    return Image.fromarray(rgba)


def planted_feet(image):
    alpha = np.array(image)[:, :, 3]
    ys, xs = np.where(alpha > 160)
    bottom = int(ys.max())
    feet = (ys >= bottom - 9)
    return float(xs[feet].mean()), bottom, bottom - int(ys.min())


def premultiply(image):
    values = np.array(image, dtype=np.float32) / 255
    values[:, :, :3] *= values[:, :, 3:4]
    return values


def inbetweens(first, second, steps=3):
    a, b = premultiply(first), premultiply(second)
    # Optical flow and alpha use the same warp, preventing a separate opaque halo.
    def gray(values):
        opaque = values[:, :, :3] + .45 * (1 - values[:, :, 3:4])
        return cv2.cvtColor((opaque * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    fwd = cv2.calcOpticalFlowFarneback(gray(a), gray(b), None, .5, 4, 21, 5, 7, 1.5, 0)
    back = cv2.calcOpticalFlowFarneback(gray(b), gray(a), None, .5, 4, 21, 5, 7, 1.5, 0)
    grid = np.stack(np.meshgrid(np.arange(256), np.arange(320)), axis=-1).astype(np.float32)
    result = []
    for t in (i / steps for i in range(1, steps)):
        wa = cv2.remap(a, grid - fwd * t, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        wb = cv2.remap(b, grid - back * (1 - t), None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        mixed = wa * (1 - t) + wb * t
        mixed[:, :, :3] /= np.maximum(mixed[:, :, 3:4], 1 / 255)
        result.append(Image.fromarray(np.clip(mixed * 255, 0, 255).astype(np.uint8)))
    return result


def build(source, output):
    sheet = Image.open(source).convert("RGBA")
    width, height = sheet.size
    cells = [clean(sheet.crop((round(i % 8 * width / 8), round(i // 8 * height / 6),
                              round((i % 8 + 1) * width / 8), round((i // 8 + 1) * height / 6)))) for i in range(48)]
    # Match the old avatar's on-screen height, retaining space for raised hands.
    scale = 294 / np.median([planted_feet(cell)[2] for cell in cells[:6]])
    frames = []
    for cell in cells:
        foot_x, foot_y, _ = planted_feet(cell)
        frame = cell.transform((256, 320), Image.Transform.AFFINE,
                               (1 / scale, 0, foot_x - 128 / scale, 0, 1 / scale, foot_y - 306 / scale),
                               Image.Resampling.BICUBIC)
        frames.append(frame)
    neutral = frames[0]
    # Each action starts AND ends with the exact same neutral pixels.
    for i in (11, 12, 23, 24, 35, 36, 47):
        frames[i] = neutral.copy()
    output.mkdir(parents=True, exist_ok=True)
    neutral.save(output / "neutral.webp", lossless=True)
    normalized = Image.new("RGBA", (256 * 8, 320 * 6))
    for i, frame in enumerate(frames):
        normalized.alpha_composite(frame, (i % 8 * 256, i // 8 * 320))
    normalized.save(output / "keyframes.webp", lossless=True)
    manifest = {"cell": [256, 320], "sourceFrames": 48, "scale": float(scale), "clips": {}}
    preview_frames, preview_times = [], []
    for name, start in (("blink", 0), ("thinking", 12), ("stretch", 24), ("spin", 36)):
        keys = frames[start:start + 12]
        animation = []
        for first, second in zip(keys, keys[1:]):
            animation.extend([first, *inbetweens(first, second)])
        animation.append(neutral.copy())
        times = [33 if i % 3 != 2 else 34 for i in range(len(animation))]
        times[-1] = 100
        if name in ("thinking", "stretch"):
            times[18] += 650 if name == "thinking" else 300
        animation[0].save(output / (name + ".webp"), save_all=True, append_images=animation[1:],
                          duration=times, loop=1, quality=90, method=4, alpha_quality=100)
        manifest["clips"][name] = {"durationMs": sum(times), "frames": len(animation), "fps": 30}
        if name == "blink":
            idle_times = times.copy()
            idle_times[0] += 3300
            animation[0].save(output / "idle.webp", save_all=True, append_images=animation[1:],
                              duration=idle_times, loop=0, quality=90, method=4, alpha_quality=100)
        preview_frames.extend(animation)
        preview_times.extend(times)
    # A complete visual preview uses the same frames as the application.
    preview_frames[0].save(output / "preview.webp", save_all=True, append_images=preview_frames[1:],
                           duration=preview_times, loop=0, quality=90, method=4, alpha_quality=100)
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for name, clip in manifest["clips"].items():
        with Image.open(output / (name + ".webp")) as image:
            image.seek(image.n_frames - 1)
            assert np.array_equal(np.array(image.convert("RGBA"))[:, :, 3], np.array(neutral)[:, :, 3]), name
            assert image.size == (256, 320)
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build(args.source, args.output)
