"""
Backdrops for the canvas: four moods, each in a light and a dark variant,
rendered at 3840x2160 from noise and gradients we own. Run once; the JPEGs
land in packages/app/renderer/backdrops/ and ship with the app.

    python brand/backdrops.py

paper   a warm sheet with a faint fibre
ink     an ink wash, darker at the edges
aurora  a slow ribbon of ember and dusk
nebula  deep field, a glow off-centre
"""

from __future__ import annotations

import os

import numpy as np
from PIL import Image, ImageFilter

W, H = 3840, 2160
OUT = os.path.join(os.path.dirname(__file__), "..", "packages", "app", "renderer", "backdrops")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)


def fbm(w: int, h: int, octaves: int = 5, base: int = 6) -> np.ndarray:
    """Fractal noise in [0,1]: layered upscaled random grids."""
    acc = np.zeros((h, w), dtype=np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        n = base * (2**o)
        grid = rng.random((n * h // w + 2, n + 2)).astype(np.float32)
        img = Image.fromarray((grid * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
        acc += np.asarray(img, dtype=np.float32) / 255.0 * amp
        total += amp
        amp *= 0.5
    return acc / total


def radial(w: int, h: int, cx: float, cy: float, r: float) -> np.ndarray:
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((x / w - cx) ** 2) + ((y / h - cy) * (h / w)) ** 2) / r
    return np.clip(1 - d, 0, 1) ** 2


def mix(a, b, t):
    t = t[..., None] if t.ndim == 2 else t
    return a * (1 - t) + b * t


def rgb(hexstr: str) -> np.ndarray:
    return np.array([int(hexstr[i : i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)


def save(name: str, img: np.ndarray) -> None:
    im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")
    path = os.path.join(OUT, f"{name}.jpg")
    im.save(path, "JPEG", quality=86, optimize=True, progressive=True)
    print(name, os.path.getsize(path) // 1024, "KB")


def paper(dark: bool) -> np.ndarray:
    base = rgb("#141110") if dark else rgb("#f3efe8")
    fibre = fbm(W, H, octaves=6, base=48)
    grain = rng.normal(0, 1, (H, W)).astype(np.float32)
    tone = (fibre - 0.5) * (18 if dark else 22) + grain * (3 if dark else 4)
    img = base[None, None, :] + tone[..., None]
    # a soft light from the top left
    light = radial(W, H, 0.2, 0.1, 1.2) * (14 if dark else 10)
    return img + light[..., None]


def ink(dark: bool) -> np.ndarray:
    a = rgb("#0e0c0b") if dark else rgb("#e9e4dc")
    b = rgb("#2a211c") if dark else rgb("#c9bfb2")
    wash = fbm(W, H, octaves=5, base=3)
    wash = np.asarray(
        Image.fromarray((wash * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(40)),
        dtype=np.float32,
    ) / 255.0
    img = mix(a[None, None, :], b[None, None, :], wash)
    edge = 1 - radial(W, H, 0.5, 0.5, 0.95)
    img = img - edge[..., None] * (10 if dark else 16)
    grain = rng.normal(0, 1, (H, W)).astype(np.float32) * 2.5
    return img + grain[..., None]


def aurora(dark: bool) -> np.ndarray:
    sky = rgb("#100d12") if dark else rgb("#efe9ea")
    ember = rgb("#d2683f")
    dusk = rgb("#5a3f6b") if dark else rgb("#b9a3c7")
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    ribbon = np.exp(-(((y / H) - (0.45 + 0.12 * np.sin(x / W * 6.28 * 0.9 + 0.6))) ** 2) / 0.012)
    ribbon2 = np.exp(-(((y / H) - (0.62 + 0.09 * np.sin(x / W * 6.28 * 1.3 + 2.1))) ** 2) / 0.02)
    n = fbm(W, H, octaves=4, base=4)
    img = sky[None, None, :]
    img = mix(img, dusk[None, None, :], np.clip(ribbon2 * (0.35 + 0.5 * n), 0, 1) * (0.9 if dark else 0.6))
    img = mix(img, ember[None, None, :], np.clip(ribbon * (0.3 + 0.6 * n), 0, 1) * (0.55 if dark else 0.35))
    img = np.asarray(
        Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(28)),
        dtype=np.float32,
    )
    grain = rng.normal(0, 1, (H, W)).astype(np.float32) * 2
    return img + grain[..., None]


def nebula(dark: bool) -> np.ndarray:
    deep = rgb("#0a0a10") if dark else rgb("#ebe9ef")
    glow = rgb("#3b2a4f") if dark else rgb("#cfc2dc")
    ember = rgb("#d2683f")
    n = fbm(W, H, octaves=6, base=5)
    cloud = np.clip((n - 0.42) * 2.4, 0, 1)
    img = mix(deep[None, None, :], glow[None, None, :], cloud * (0.9 if dark else 0.7))
    core = radial(W, H, 0.68, 0.38, 0.5)
    img = mix(img, ember[None, None, :], core * cloud * (0.5 if dark else 0.3))
    img = np.asarray(
        Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(14)),
        dtype=np.float32,
    )
    if dark:
        stars = (rng.random((H, W)) > 0.99965).astype(np.float32)
        stars = np.asarray(
            Image.fromarray((stars * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8)),
            dtype=np.float32,
        ) / 255.0
        img = img + stars[..., None] * 160
    return img


for name, fn in [("paper", paper), ("ink", ink), ("aurora", aurora), ("nebula", nebula)]:
    save(f"{name}-dark", fn(True))
    save(f"{name}-light", fn(False))
