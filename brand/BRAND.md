# ClaudeTalks — brand

## 1. The mark

ClaudeTalks already drew its own logo before anyone designed one. The island
pill carries a small sparkle glyph, and immediately to its right, a five-bar
level meter that moves when you speak. Two symbols, side by side, saying the
same thing badly.

The mark is those two collapsed into one: **a radial burst whose ray lengths
run as a waveform.** It reads as a spark at a glance and as sound the moment
you look twice, which is the product — an agent that talks.

It sits in the same visual family as Claude's own mark on purpose; this is a
voice layer for Claude Code and it should look like it belongs near it. It is
deliberately **not** a copy. Anthropic's starburst is their trademark, the
product name already borrows "Claude", and the resemblance stops at the family.

Twelve rays, 30° apart, lengths mirrored about the vertical axis. The mirroring
is the whole trick: an unmirrored waveform reads as a mistake at logo size,
because the eye cannot tell that the unevenness was chosen. The vertical rays
are the longest so the glyph has an axis to stand on.

## 2. Construction

Drawn from scratch as geometric monoline paths — no font dependency, so the
files render identically everywhere and scale to any size. Nothing here is
type set in a typeface and outlined; a logo that falls back to Arial on a
machine without the font is not a logo.

**Wordmark grid:**

| | |
|---|---|
| baseline | y = 100 |
| x-height top | y = 60 (40 units, exactly 4× the stroke) |
| ascender | y = 36 |
| stroke | 10, round caps and joins |
| bowl radius | 20 — a bowl spans the full x-height |

Single stroke weight throughout. Circular bowls, drawn as `<circle>` where they
are whole circles, because they are. Single-storey `a`. The `s` is the one
ellipse in the set: two stacked circles at this x-height would make it 20 wide
against a 40-wide `o`, which reads as a typo rather than a narrow letter.

**Mark grid:** 64 box, centre (32,32), inner radius 9, stroke 4.5, outer radii
`27 19 24 16 22 15 27 15 22 16 24 19`.

## 3. Small sizes

Below about 24px the twelve rays turn to mush. **`mark-small.svg` drops every
other ray** — six rays, stroke 6.5 — and that is the variant the island uses at
16px and the favicon uses at 32px and under. Do not shrink the full burst past
24px and hope.

## 4. Colour

| | hex | use |
|---|---|---|
| Ink | `#14100E` | text, the mark on light |
| Paper | `#F5F1EC` | ground, the mark on dark |
| Ember | `#D2683F` | the one accent |

Ember is the only colour that is not ink or paper. Use it for one thing on a
surface, not for a palette.

**No green anywhere.** Green belongs to runnn, where it has a rule attached to
it, and borrowing it here would break that rule in the one place it matters.

## 5. Files

| File | Use |
|---|---|
| `wordmark.svg` / `-reversed` / `-mono` | The primary logo. Use this unless there is a reason not to. |
| `mark.svg` / `-reversed` / `-mono` | Avatars, stamps, anywhere the name is already on the page. |
| `mark-small.svg` | 16–24px. Six rays. |
| `lockup.svg` / `-reversed` | Wide headers, readme banners, slides. |
| `app-icon.svg` | Ink field, paper mark. Squares. |
| `app-icon-ember.svg` | The same on ember, when the ink version disappears into a dark dock. |
| `favicon-small.svg` | 32px and under. |

`-mono` variants inherit `currentColor` — one file for light, dark and reversed.

## 6. After editing the artwork

Nothing regenerates automatically. Re-render the PNGs by hand. The files are
small, they change rarely, and a build step that silently redraws a logo is
worse than this paragraph.

## 6. The orb (Kikoe, 2026-09-05)

The mark now lives inside a sphere: a lit orb in ember and paper on ink,
with the twelve-ray burst centred in it in paper. **The orb is the logo.**
It is the voice you talk to, as a thing in the room, and it is the same
object the app animates: dim when idle, a paper ring when listening, ripples
when speaking, an ember ring when it has asked you something.

| File | Use |
|---|---|
| `orb.svg` | The logo. Any size from 24px up. |
| `app-icon-orb-1024.png` / `-512` | The app icon: the orb on an ink field. |
| `mark.svg`, `mark-small.svg` | The bare burst, for monochrome and for inside the orb at pill size (six rays below 24px). |

The sphere's gradient is the CSS the app uses, so the icon and the live orb
never drift apart. Ember stays the one accent; the sphere is ember because
it *is* the accent, not an exception to the rule.
