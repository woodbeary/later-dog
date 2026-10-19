import argparse
import io
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image


def parse():
    parser = argparse.ArgumentParser(description="Encode recorded scene frames as an animated WebP with no ghost trails.")
    parser.add_argument("frames")
    parser.add_argument("out")
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--tick", type=int, default=40)
    parser.add_argument("--quality", type=int, default=88)
    parser.add_argument("--settle-ms", type=int, default=20)
    parser.add_argument("--hold-ms", type=int, default=160)
    parser.add_argument("--trim-end-ms", type=int, default=0)
    parser.add_argument("--first-ms", type=int, default=0)
    parser.add_argument("--lossless-area", type=int, default=120000)
    parser.add_argument("--timeline", default="")
    return parser.parse_args()


def timeline(meta, tick, trim_end_ms, first_ms):
    starts = []
    total = 0
    for frame in meta["frames"]:
        starts.append(total)
        total += frame["ms"]
    end = total - trim_end_ms
    picked = []
    source = 0
    for t in range(0, end, tick):
        while source + 1 < len(starts) and starts[source + 1] <= t:
            source += 1
        if picked and picked[-1][0] == source:
            picked[-1][1] += tick
        else:
            picked.append([source, tick])
    if first_ms:
        picked[0][1] = min(picked[0][1], first_ms)
    return picked


class Frames:
    def __init__(self, directory, meta, scale):
        self.directory = directory
        self.meta = meta
        self.scale = scale
        self.cache = {}

    def get(self, index):
        if index not in self.cache:
            name = os.path.basename(self.meta["frames"][index]["file"])
            image = Image.open(os.path.join(self.directory, name)).convert("RGB")
            if self.scale != 1.0:
                width = round(image.width * self.scale / 2) * 2
                height = round(image.height * width / image.width)
                image = image.resize((width, height), Image.LANCZOS)
            self.cache = {index: np.asarray(image)}
        return self.cache[index]


TILE = 8


def encode(pixels, lossless, quality):
    buffer = io.BytesIO()
    image = Image.fromarray(pixels)
    if lossless:
        image.save(buffer, "WEBP", lossless=True, quality=100, method=4, exact=True)
    else:
        image.save(buffer, "WEBP", quality=quality, alpha_quality=100, method=4)
    data = buffer.getvalue()
    return data, np.asarray(Image.open(io.BytesIO(data)).convert("RGBA"))[:, :, :3]


def tile_mask(difference, threshold):
    height, width = difference.shape
    rows = -(-height // TILE)
    cols = -(-width // TILE)
    padded = np.zeros((rows * TILE, cols * TILE), dtype=bool)
    padded[:height, :width] = difference > threshold
    tiles = padded.reshape(rows, TILE, cols, TILE).any(axis=(1, 3))
    if not tiles.any():
        return None
    return np.repeat(np.repeat(tiles, TILE, axis=0), TILE, axis=1)[:height, :width]


def bounds(mask):
    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    return int(cols[0]) & ~1, int(rows[0]) & ~1, int(cols[-1]) + 1, int(rows[-1]) + 1


def difference(a, b):
    return np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2)


class Animation:
    def __init__(self, work, args):
        self.work = work
        self.args = args
        self.canvas = None
        self.frames = []

    def start(self, pixels, ms, source):
        data, decoded = encode(pixels, True, 100)
        self.canvas = decoded.copy()
        self.write(data, 0, 0, ms, source, "-b")

    def update(self, pixels, mask, quality, ms, source):
        x0, y0, x1, y1 = bounds(mask)
        inside = mask[y0:y1, x0:x1]
        crop = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.uint8)
        crop[inside, :3] = pixels[y0:y1, x0:x1][inside]
        crop[inside, 3] = 255
        exact = quality == 0
        if exact:
            data, decoded = encode(crop, True, 100)
        else:
            data, decoded = encode(crop, False, quality)
            if inside.sum() <= self.args.lossless_area:
                lossless, lossless_decoded = encode(crop, True, 100)
                if len(lossless) <= len(data) * 1.3:
                    data, decoded, exact = lossless, lossless_decoded, True
        region = self.canvas[y0:y1, x0:x1]
        region[inside] = decoded[inside]
        self.write(data, x0, y0, ms, source, "+b")
        return exact

    def write(self, data, x, y, ms, source, blend):
        path = os.path.join(self.work, f"f{len(self.frames):05d}.webp")
        with open(path, "wb") as handle:
            handle.write(data)
        self.frames.append({"path": path, "x": x, "y": y, "ms": ms, "source": source, "blend": blend})

    def extend(self, ms):
        self.frames[-1]["ms"] += ms

    def save(self, out):
        command = ["webpmux"]
        for frame in self.frames:
            command += ["-frame", frame["path"], f"+{frame['ms']}+{frame['x']}+{frame['y']}+0{frame['blend']}"]
        command += ["-loop", "0", "-bgcolor", "255,255,255,255", "-o", out]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    args = parse()
    meta = json.load(open(os.path.join(args.frames, "frames.json")))
    plan = timeline(meta, args.tick, args.trim_end_ms, args.first_ms)
    frames = Frames(args.frames, meta, args.scale)
    previous = None
    previous_source = None
    dirty = None
    with tempfile.TemporaryDirectory() as work:
        animation = Animation(work, args)
        for position, (source, ms) in enumerate(plan):
            pixels = frames.get(source)
            if previous is None:
                animation.start(pixels, ms, source)
                dirty = np.zeros(pixels.shape[:2], dtype=bool)
                previous, previous_source = pixels, source
                continue
            motion = tile_mask(difference(pixels, previous), 0)
            moving = motion if motion is not None else np.zeros_like(dirty)
            if ms >= args.hold_ms or position == len(plan) - 1:
                mask = dirty | moving
                if mask.any():
                    animation.update(pixels, mask, 0, ms, source)
                else:
                    animation.extend(ms)
                dirty[:] = False
            else:
                settled = dirty & ~moving
                if settled.any():
                    fix_ms = args.settle_ms if motion is not None else ms
                    animation.update(previous, settled, 0, fix_ms, previous_source)
                    dirty &= ~settled
                    ms -= fix_ms
                if motion is not None:
                    exact = animation.update(pixels, motion, args.quality, ms, source)
                    dirty = dirty & ~motion if exact else dirty | motion
                elif ms:
                    animation.extend(ms)
            previous, previous_source = pixels, source
        animation.save(args.out)
        if args.timeline:
            json.dump([{"source": f["source"], "ms": f["ms"]} for f in animation.frames], open(args.timeline, "w"))
        count = len(animation.frames)
    sys.stdout.write(f"{args.out}: {count} frames, {os.path.getsize(args.out)} bytes\n")


main()
