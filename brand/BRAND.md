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

## 3. Colour

| | hex | use |
|---|---|---|
| Ink | `#14100E` | ground, text on light |
| Paper | `#F5F1EC` | text on dark, こえ |
| Ember | `#D2683F` | the one accent |

Ember is the only colour that is not ink or paper. Use it for one thing on a
surface, not for a palette. On the icon it is the glow behind the word: the
warmth the orb used to carry, kept as light rather than as a shape.

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
