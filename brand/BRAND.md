# Kikoe — brand

## 1. こえ is the logo

**こえ** (*koe*) is Japanese for "voice", and the product is a voice. The
name, Kikoe (聞こえ), means "audibility"; the logo is the part of the name
that talks. Set on 2026-09-24, replacing the orb-and-burst mark.

The two kana are drawn from **Noto Serif JP** (SIL Open Font License, which
allows a logo made from its outlines), tracked a little tighter than text.
They are kept as outlines in `koe-paths.json`, so the mark looks the same on
every machine and never depends on a font being installed. A serif, because
the page and the app speak in Instrument Serif; a mincho cut is its natural
Japanese partner.

Three weights, one per job:

| Weight | Where |
|---|---|
| 500 | the logo at 28px tall and up: the app icon, the site's hero, the README |
| 700 | 14–28px: the title bar, the site's nav, the phone's header |
| 900 | under 48px square: the favicon, the small app icon, the tray |

Below 48px the 500's thin strokes disappear, so the small tile uses the 900
set larger. Do not shrink the big icon and hope.

## 2. The orb is Kik, not the logo

The dotted orb (the thinking-orbs engine, MIT) is Kik's live state: breathing
when idle, a wave when listening, a ribbon when speaking, a web when it has
asked you something. It shows *what Kik is doing*, so it belongs where Kik
is: the Room, the phone's talk button, the island. It is never the logo, and
the logo never animates.

## 3. Colour: the design system

Since 2026-10-14 the app has one design system, **neon** (after K.A.R.A's
desk). Every surface reads its tokens from
`packages/app/renderer/room/tokens.css`. Nothing defines a colour of its
own; a stylesheet names a token.

| token | neon | use |
|---|---|---|
| `--ground` | `#07040A` | the page behind everything |
| `--surface-rgb` | `16, 8, 20` | cards, panels, menus (with alpha) |
| `--ink` | `#F6E9F1` | text and lines |
| `--muted` / `--muted-2` / `--faint` | `#A08A99` / `#6C5A67` / `#3A2B36` | secondary text, quieter, hairlines |
| `--accent` | `#FF2E88` | the live colour: active, asked, selected |
| `--accent-2` | `#A855F7` | its companion (the violet in the light) |
| `--accent-3` | `#FFAA3C` | the warm third (charts, code on the rings) |
| `--danger` | `#FF8FA3` | removed lines, errors |

**Ember is the alternate palette** of the same tokens: Ink `#14100E`, Paper
`#F5F1EC`, Ember `#D2683F`. It is chosen in Settings → Look or with the
desk's ◐ (`theme.js`). The icon and こえ keep ember, as the brand mark.

**No green anywhere.** Green belongs to runnn, where it has a rule attached
to it, and borrowing it here would break that rule in the one place it
matters.

## 4. Files

All made by `node brand/make.mjs` from `koe-paths.json`. Run it again after
changing a colour or a weight; nothing else redraws them.

| File | Use |
|---|---|
| `koe.svg` | The wordmark in paper, for dark grounds. |
| `koe-ink.svg` | The wordmark in ink, for light grounds. |
| `koe-mono.svg` | Inherits `currentColor`. |
| `koe-small.svg` | The 900 cut, `currentColor`, for small sizes. |
| `app-icon.svg` / `-1024.png` / `-512.png` | The app icon: こえ on an ink tile with the ember glow. |
| `app-icon-small.svg` | The 48px-and-under tile: the favicon and the tray. |
| `koe-paths.json` | The outlines, at 500, 700 and 900. The source of everything above. |
| `make.mjs` | Writes all of the above, plus `packages/app/build/icon.png`, `icon.ico`, `tray.png`, `trayTemplate.png` (+ `@2x`), and the site's `app/icon.svg` and `components/koe.ts`. |
| `backdrops.py` | Regenerates the Room's backdrops in `packages/app/renderer/backdrops`. |

The app's title bar carries the 700 outline inline (`renderer/room/index.html`),
so a change of weight there is a one-line edit by hand.
