// The living backdrop: light behind frosted glass that follows the Room.
//
// Asked for 2026-09-24: "a dynamic background light that changes colour and
// reacts to anything on the canvas, but with frosted glass on it, similar to
// how the current background is." So: a few large, soft pools of colour that
// drift on their own, under a grain and a dim that match the aurora image.
//
//  - Its colour is Kik's state: ember when it speaks, a cooler light while it
//    listens, violet while it thinks, amber while it waits on you, and a
//    deep, slow aurora at rest.
//  - It answers the canvas: a card that arrives sends a soft light out from
//    where it landed; an error flushes it red for a moment.
//
// Cheap on purpose. The pools are blurred once and only ever moved and
// faded (transform and opacity, on the compositor), there is no
// backdrop-filter, and a phone gets fewer and slower ones; under
// prefers-reduced-motion they stay still and only the colour changes.
//
// window.ambient = { mood(state, label), flash(x, y, kind), on(bool) }

(() => {
  const board = document.getElementById("board");
  if (!board) return;
  const phone = document.documentElement.dataset.phone === "true";
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  /** the colours of each mood: four pools, as rgb triples */
  const MOODS = {
    idle: ["58 46 150", "112 38 132", "24 68 138", "150 62 44"],
    listening: ["44 110 170", "70 64 170", "30 120 150", "120 80 160"],
    thinking: ["120 60 190", "80 40 160", "160 70 150", "60 70 170"],
    speaking: ["210 104 63", "170 70 60", "140 60 120", "90 50 140"],
    asking: ["210 140 60", "190 104 63", "120 70 60", "90 60 130"],
    error: ["190 50 50", "140 40 60", "110 40 90", "80 40 110"],
  };

  const layer = document.createElement("div");
  layer.className = "ambient";
  layer.setAttribute("aria-hidden", "true");
  const pools = [];
  const count = phone ? 3 : 4;
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "ambient-pool";
    p.style.setProperty("--i", String(i));
    layer.append(p);
    pools.push(p);
  }
  const flashes = document.createElement("div");
  flashes.className = "ambient-flashes";
  layer.append(flashes);
  // under everything the board draws: the first child, so the world stacks above
  board.prepend(layer);

  let current = "";
  function paint(name) {
    const set = MOODS[name] ?? MOODS.idle;
    if (current === name) return;
    current = name;
    // a whole colour, so the registered property can fade from one to the next
    pools.forEach((p, i) => p.style.setProperty("--c", `rgb(${set[i % set.length]})`));
  }

  /** Kik's state, as setOrb has it: speaking, listening, asking, idle; "thinking" by label. */
  function mood(state, label) {
    if (label === "thinking" || state === "thinking") return paint("thinking");
    if (state === "speaking") return paint("speaking");
    if (state === "listening") return paint("listening");
    if (state === "asking") return paint("asking");
    paint("idle");
  }

  /** A soft light out from a point on the screen: a card arriving, a fault. */
  function flash(x, y, kind = "arrive") {
    if (board.dataset.backdrop !== "live") return;
    if (kind === "error") {
      const before = current;
      paint("error");
      setTimeout(() => paint(before || "idle"), 2200);
    }
    if (calm?.matches) return;
    const f = document.createElement("div");
    f.className = `ambient-flash ${kind}`;
    const r = board.getBoundingClientRect();
    f.style.left = `${x - r.left}px`;
    f.style.top = `${y - r.top}px`;
    flashes.append(f);
    f.addEventListener("animationend", () => f.remove());
    // never a pile of them, whatever arrives at once
    while (flashes.childElementCount > 4) flashes.firstElementChild?.remove();
  }

  paint("idle");
  window.ambient = { mood, flash };
  window.addEventListener("board:arrive", (e) => {
    const d = e.detail || {};
    flash(d.x, d.y, d.kind || "arrive");
  });
})();
