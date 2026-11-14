"""Build uniformly sampled 60 Hz texture pages from the original pet art.

Uses decoded source GIFs/keyframes, not previously interpolated WebP files.
Only the current/next small page needs decoding in the application.
"""
import importlib.util
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("emotion_assets", Path(__file__).with_name("build-asaba-emotions.py"))
old = importlib.util.module_from_spec(spec)
spec.loader.exec_module(old)
np, cv2, Image = old.np, old.cv2, old.Image
from PIL import ImageSequence, ImageFilter, ImageDraw

SIZE = (256, 320)
FPS, COLUMNS, ROWS = 60, 6, 4
OUT = ROOT / "desktop/asaba-motion"
ONLY = None


def field(first, second):
    a, b = old.assets.premultiply(first), old.assets.premultiply(second)
    def gray(values):
        rgb = values[:, :, :3] + .45 * (1 - values[:, :, 3:4])
        return cv2.cvtColor((rgb * 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    ga, gb = gray(a), gray(b)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    fwd, back = dis.calc(ga, gb, None), dis.calc(gb, ga, None)
    grid = np.stack(np.meshgrid(np.arange(SIZE[0]), np.arange(SIZE[1])), axis=-1).astype(np.float32)
    # Inverse maps are solved iteratively. A single backward offset, used by the
    # old interpolator, misaligned curved/rotating outlines and doubled edges.
    def remap(values, coordinates):
        return cv2.remap(values, coordinates, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    cf = np.exp(-np.linalg.norm(fwd + remap(back, grid + fwd), axis=2) / 3).clip(.15, 1)
    cb = np.exp(-np.linalg.norm(back + remap(fwd, grid + back), axis=2) / 3).clip(.15, 1)
    def sample(t):
        pa, pb = grid.copy(), grid.copy()
        for _ in range(4):
            pa = grid - remap(fwd, pa) * t
            pb = grid - remap(back, pb) * (1 - t)
        wa, wb = remap(a, pa), remap(b, pb)
        ca, cb_ = remap(cf, pa)[:, :, None] * (1 - t), remap(cb, pb)[:, :, None] * t
        mixed = (wa * ca + wb * cb_) / np.maximum(ca + cb_, .0001)
        mixed[:, :, :3] /= np.maximum(mixed[:, :, 3:4], 1 / 255)
        return Image.fromarray(np.clip(mixed * 255, 0, 255).astype(np.uint8))
    return sample


def emit(name, keys, intervals, manifest):
    if ONLY and name != ONLY:
        return
    count = round(sum(intervals) * FPS / 1000)
    duration = count * 1000 / FPS
    frames, elapsed, segment = [], 0., 0
    interpolate = field(keys[0], keys[1])
    for index in range(count + 1):
        time = min(index * 1000 / FPS, sum(intervals))
        while segment < len(intervals) - 1 and time > elapsed + intervals[segment] + .001:
            elapsed += intervals[segment]
            segment += 1
            interpolate = field(keys[segment], keys[segment + 1])
        t = np.clip((time - elapsed) / intervals[segment], 0, 1)
        if index == 0 or index == count:
            frame = keys[0].copy()
        elif t < .0001:
            frame = keys[segment].copy()
        elif t > .9999:
            frame = keys[segment + 1].copy()
        else:
            frame = interpolate(float(t))
        frames.append(frame)
    pages = []
    for start in range(0, len(frames), COLUMNS * ROWS):
        page = Image.new("RGBA", (SIZE[0] * COLUMNS, SIZE[1] * ROWS))
        for i, frame in enumerate(frames[start:start + COLUMNS * ROWS]):
            page.alpha_composite(frame, (i % COLUMNS * SIZE[0], i // COLUMNS * SIZE[1]))
        filename = f"{name}-{len(pages):02}.webp"
        page.save(OUT / filename, quality=90, method=4, alpha_quality=100)
        pages.append(filename)
    assert np.array_equal(np.array(frames[0]), np.array(frames[-1])), name
    manifest["clips"][name] = {"frames": len(frames), "durationMs": duration, "pages": pages}
    print(name, len(frames), len(pages), flush=True)


def main():
    OUT.mkdir(exist_ok=True)
    neutral = Image.open(ROOT / "desktop/asaba-animation/neutral.webp").convert("RGBA")
    neutral.save(OUT / "neutral.webp", lossless=True)
    manifest = json.loads((OUT / "manifest.json").read_text()) if ONLY else {
        "version": 3, "width": 256, "height": 320, "fps": FPS, "columns": COLUMNS,
        "rows": ROWS, "pageFrames": COLUMNS * ROWS, "neutral": "neutral.webp", "clips": {}}
    sheet = Image.open(ROOT / "desktop/asaba-animation/keyframes.webp").convert("RGBA")
    cells = [sheet.crop((i % 8 * 256, i // 8 * 320, (i % 8 + 1) * 256, (i // 8 + 1) * 320)) for i in range(48)]
    # Blink only changes the face. Generated poses used to make the hair, body
    # and clothing wobble even though only the eyelids were moving.
    mask = Image.new("L", SIZE)
    ImageDraw.Draw(mask).ellipse((67, 91, 188, 162), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(5))
    blink = [Image.composite(cells[i], neutral, mask) for i in [0, 5, 6, 7, 8, 9, 10, 0]]
    blink[0] = blink[-1] = neutral
    emit("blink", blink, [35, 45, 45, 50, 45, 50, 50], manifest)
    for name, start, hold in [("thinking", 12, 650), ("stretch", 24, 300)]:
        keys = cells[start:start + 12]
        intervals = [100] * 11
        keys[0] = keys[-1] = neutral
        keys.insert(7, keys[6])
        intervals.insert(6, hold)
        emit(name, keys, intervals, manifest)
    # Keep the native 'spin' cue, but use the original portrait for a continuous
    # dance. Normalizing GIF height cannot correct a changed head/body ratio.
    if not ONLY or ONLY == "spin":
        manifest["clips"]["spin"] = {"frames": 1, "durationMs": 4200, "pages": ["neutral.webp"], "procedural": True}
    reference_height = old.assets.planted_feet(neutral)[2]
    for path in sorted((ROOT / "assets/asaba/emotions").glob("*.gif")):
        if path.stem == "spin" or (ONLY and path.stem != ONLY):
            continue
        with Image.open(path) as gif:
            raw = [(old.transparent(f), max(30, f.info.get("duration", 100))) for f in ImageSequence.Iterator(gif)]
        scale = reference_height / np.median([old.assets.planted_feet(f)[2] for f, _ in raw[:3]])
        poses = []
        for frame, _ in raw:
            x, y, _ = old.assets.planted_feet(frame)
            poses.append(frame.transform(SIZE, Image.Transform.AFFINE,
                         (1 / scale, 0, x - 128 / scale, 0, 1 / scale, y - 306 / scale), Image.Resampling.BICUBIC))
        emit(path.stem, [neutral, *poses, poses[-1], neutral], [200, *(d for _, d in raw), 200], manifest)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=["blink", "thinking", "stretch", "spin", "cheer", "cuddle", "sleepy"])
    ONLY = parser.parse_args().only
    main()
