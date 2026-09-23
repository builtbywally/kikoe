// Thinking orbs: Kik's states drawn as dotted thought-orbs.
//
// The drawing is Jakub Antalik's thinking-orbs engine (MIT, vendor/,
// github.com/Jakubantalik/thinking-orbs): nine animated states, each tuned at
// two sizes, on a plain 2D canvas. Its React component is replaced by this
// small loop, because the Room, the phone and the island load plain scripts.
//
// One clock and one animation frame for every orb on the page, the way the
// original shares one clock: orbs stay in phase and cost one callback. It
// stops while the page is hidden, and with reduced motion each orb is one
// still frame. A canvas that leaves the page leaves the loop.
//
//   const orb = KikOrb.create(canvas, { state: "breathing", size: 64 });
//   orb.set("listening");
//   KikOrb.forKik("speaking")  // → "composing": Kik's state in orb words

(() => {
  const E = window.ThinkingOrbsEngine;
  if (!E) return;

  /** Kik's states, as the orb verbs that look like them. */
  const FOR_KIK = {
    idle: "breathing",
    quiet: "breathing",
    listening: "listening",
    hearing: "listening",
    transcribing: "listening",
    thinking: "working",
    speaking: "composing",
    asking: "connecting",
    thought: "solving",
    agent: "working",
    waiting: "connecting",
  };

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const orbs = new Set();
  let raf = 0;

  function paint(o, t) {
    const { canvas, ctx } = o;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(o.size * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, o.size, o.size);
    const draw = E.MODE_DRAWS[o.mode];
    // the ink follows the surface: light dots on Kikoe's dark rooms
    draw(ctx, o.size, t * o.speed, o.dark, o.opts);
  }

  function tick() {
    raf = 0;
    const t = performance.now() / 1000;
    for (const o of orbs) {
      if (!o.canvas.isConnected) {
        orbs.delete(o);
        continue;
      }
      paint(o, t);
    }
    if (orbs.size && !document.hidden && !reduced.matches) raf = requestAnimationFrame(tick);
  }
  function run() {
    if (!raf && !document.hidden) raf = requestAnimationFrame(tick);
  }
  document.addEventListener("visibilitychange", run);

  function create(canvas, o = {}) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return { set() {}, destroy() {} };
    const size = o.size === 20 ? 20 : 64;
    canvas.style.width = canvas.style.width || `${size}px`;
    canvas.style.height = canvas.style.height || `${size}px`;
    canvas.setAttribute("role", "img");
    // light dots on a dark surface; dark dots when the page is in light mode
    const dark = o.dark ?? !window.matchMedia("(prefers-color-scheme: light)").matches;
    const orb = { canvas, ctx, size, dark, state: "", mode: "", speed: 1, opts: {} };
    const api = {
      set(state) {
        if (!state || state === orb.state) return;
        const r = E.resolvePreset(state, size);
        orb.state = state;
        orb.mode = r.mode;
        orb.speed = r.speed * (o.speed ?? 1);
        orb.opts = r.opts;
        canvas.dataset.orb = state;
        canvas.setAttribute("aria-label", o.label?.(state) ?? state);
        if (reduced.matches) paint(orb, 0.6);
        run();
      },
      destroy() {
        orbs.delete(orb);
      },
    };
    orbs.add(orb);
    api.set(o.state || "breathing");
    return api;
  }

  window.KikOrb = {
    create,
    /** An orb verb for one of Kik's states; "breathing" for anything unknown. */
    forKik: (s) => FOR_KIK[s] ?? "breathing",
  };
})();
