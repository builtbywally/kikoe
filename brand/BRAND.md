# Kikoe — brand

## 1. The orb is the logo

A lit sphere in ember and paper on ink, with the twelve-ray burst centred in
it in paper. It is the voice you talk to, as a thing in the room, and it is
the same object the app animates: dim when idle, a paper ring when
listening, ripples when speaking, an ember ring when it has asked you
something.

The sphere's gradient is the CSS the app uses, so the icon and the live orb
never drift apart.

## 2. The burst inside it

A radial burst whose ray lengths run as a waveform: a spark at a glance and
sound the moment you look twice, which is the product — something that
talks. It sits in the same visual family as Claude's mark on purpose and is
deliberately **not** a copy; the resemblance stops at the family.

Twelve rays, 30° apart, lengths mirrored about the vertical axis. The
mirroring is the whole trick: an unmirrored waveform reads as a mistake at
logo size, because the eye cannot tell the unevenness was chosen. The
vertical rays are the longest so the glyph has an axis to stand on.

**Grid:** 64 box, centre (32,32), inner radius 9, stroke 4.5, round caps,
outer radii `27 19 24 16 22 15 27 15 22 16 24 19`. Geometric paths, no font.

Below about 24px the twelve rays turn to mush: **`mark-small.svg` drops every
other ray** (six rays, stroke 6.5). The island uses it at 16px and the
favicon at 32px and under. Do not shrink the full burst past 24px and hope.

## 3. Colour

| | hex | use |
|---|---|---|
| Ink | `#14100E` | ground, text on light |
| Paper | `#F5F1EC` | text on dark, the burst |
| Ember | `#D2683F` | the one accent |

Ember is the only colour that is not ink or paper. Use it for one thing on a
surface, not for a palette. The sphere is ember because it *is* the accent,
not an exception to the rule.

**No green anywhere.** Green belongs to runnn, where it has a rule attached
to it, and borrowing it here would break that rule in the one place it
matters.

## 4. Files

| File | Use |
|---|---|
| `orb.svg` | The logo. Any size from 24px up. |
| `app-icon-orb-1024.png` / `-512` | The app icon: the orb on an ink field (`packages/app/build/icon.png` is the 1024). |
| `mark.svg` / `-reversed` / `-mono` (+ `.png`) | The bare burst: avatars, stamps, monochrome. `-mono` inherits `currentColor`. |
| `mark-small.svg` | 16–24px. Six rays. |
| `favicon-small.svg` | 32px and under. |
| `backdrops.py` | Regenerates the Room's backdrops in `packages/app/renderer/backdrops`. |

Nothing regenerates automatically. Re-render the PNGs by hand: the files are
small, they change rarely, and a build step that silently redraws a logo is
worse than this paragraph.

The wordmark and lockups were ClaudeTalks's and said so; they were removed
on 2026-09-24. The app sets the name in type beside the orb.
