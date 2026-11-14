"""Normalize the original GPT GIFs and bridge their poses to the pet's neutral.

Build-time only; uses the same tools as build-asaba-animation.py.
"""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("asaba_assets", Path(__file__).with_name("build-asaba-animation.py"))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)
cv2, np, Image = assets.cv2, assets.np, assets.Image
from PIL import ImageSequence


def transparent(frame):
    rgba = np.array(frame.convert("RGBA"))
    if rgba[:, :, 3].min() == 255:
        # Some GIF exports bake in a pale checkerboard. Remove only the bright,
        # near-neutral area connected to the outer border, preserving white
        # hair, clothing and the toy enclosed by the character's outline.
        rgb = rgba[:, :, :3].astype(np.int16)
        candidate = ((rgb.min(axis=2) >= 210) & (rgb.max(axis=2) - rgb.min(axis=2) < 24)).astype(np.uint8)
        _, labels = cv2.connectedComponents(candidate)
        border = np.unique(np.concatenate((labels[0], labels[-1], labels[:, 0], labels[:, -1])))
        border = border[border != 0]
        foreground = np.where(np.isin(labels, border), 0, 255).astype(np.uint8)
        # GIF palette quantization can open tiny gaps in a pale hair outline.
        # Close those gaps and fill the exterior silhouette before assigning
        # alpha, so bright hair and clothes never become transparent holes.
        foreground = cv2.morphologyEx(foreground, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
        contours, _ = cv2.findContours(foreground, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        alpha = np.zeros_like(foreground)
        cv2.drawContours(alpha, [max(contours, key=cv2.contourArea)], -1, 255, cv2.FILLED)
        rgba[:, :, 3] = alpha
    return assets.clean(Image.fromarray(rgba))


def build(source, output, neutral_path):
    neutral = Image.open(neutral_path).convert("RGBA")
    reference_height = assets.planted_feet(neutral)[2]
    output.mkdir(parents=True, exist_ok=True)
    manifest = {"cell": [256, 320], "clips": {}}
    preview, preview_times = [], []
    for path in sorted(source.glob("*.gif")):
        with Image.open(path) as gif:
            raw = [(transparent(frame), max(30, frame.info.get("duration", 100))) for frame in ImageSequence.Iterator(gif)]
        if len(raw) < 12:
            raise ValueError(f"{path.name}: insufficient animation frames")
        scale = reference_height / np.median([assets.planted_feet(frame)[2] for frame, _ in raw[:3]])
        normalized = []
        for frame, _ in raw:
            x, y, _ = assets.planted_feet(frame)
            normalized.append(frame.transform((256, 320), Image.Transform.AFFINE,
                (1 / scale, 0, x - 128 / scale, 0, 1 / scale, y - 306 / scale), Image.Resampling.BICUBIC))
        keys = [neutral, *normalized, normalized[-1], neutral]
        intervals = [180, *(duration for _, duration in raw), 180]
        animation, durations = [], []
        elapsed = 0
        for first, second, duration in zip(keys, keys[1:], intervals):
            count = max(1, round((elapsed + duration) * 30 / 1000) - round(elapsed * 30 / 1000))
            animation.extend([first, *assets.inbetweens(first, second, count)])
            times = [round((i + 1) * duration / count) - round(i * duration / count) for i in range(count)]
            durations.extend(times)
            elapsed += duration
        animation.append(neutral.copy())
        durations.append(100)
        animation[0].save(output / (path.stem + ".webp"), save_all=True, append_images=animation[1:],
                          duration=durations, loop=1, quality=90, method=4, alpha_quality=100)
        heights, bottoms = [], []
        with Image.open(output / (path.stem + ".webp")) as clip:
            for frame in ImageSequence.Iterator(clip):
                _, bottom, height = assets.planted_feet(frame.convert("RGBA"))
                heights.append(height); bottoms.append(bottom)
            assert np.array_equal(np.array(clip.convert("RGBA"))[:, :, 3], np.array(neutral)[:, :, 3])
        assert min(heights) >= reference_height * .93, (path.stem, heights)
        assert max(bottoms) - min(bottoms) <= 4, (path.stem, bottoms)
        manifest["clips"][path.stem] = {"durationMs": sum(durations), "sourceFrames": len(raw), "frames": len(animation), "fps": 30}
        preview.extend(animation); preview_times.extend(durations)
        print(path.stem, manifest["clips"][path.stem], flush=True)
    preview[0].save(output / "preview.webp", save_all=True, append_images=preview[1:], duration=preview_times,
                    loop=0, quality=90, method=4, alpha_quality=100)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--neutral", type=Path, default=Path(__file__).resolve().parents[1] / "desktop/asaba-animation/neutral.webp")
    args = parser.parse_args()
    build(args.source, args.output, args.neutral)
