// The desk answers what you do: a short sound and a pulse of the sphere on
// every action, right-click menus on cards, areas and the empty canvas, and a
// card dropped on Kik's sphere is a question about it. The actions it offers
// are the palette's (palette.js), so a menu, a key and the voice reach the
// same thing.
(() => {
  // --- feel: sound and the sphere -------------------------------------------------------
  // Synthesised, a few milliseconds each, quiet. Off with the palette's
  // "sounds off" or prefers-reduced-motion for the pulse.
  let audio = null;
  const soundsOn = () => localStorage.getItem("kik.sounds") !== "off";
  const TONES = {
    act: [660, 0.05, 0.035],
    open: [520, 0.07, 0.03, 780],
    send: [440, 0.09, 0.04, 880],
    drop: [180, 0.09, 0.05],
    menu: [740, 0.04, 0.025],
    tick: [900, 0.025, 0.02],
    save: [600, 0.08, 0.035, 990],
    error: [220, 0.16, 0.05, 160],
  };
  function tone([f, dur, gain, to]) {
    try {
      audio ??= new AudioContext();
      const t = audio.currentTime;
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(f, t);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    } catch {
      /* no audio here */
    }
  }
  window.kik = window.kik ?? {};
  window.kik.feel = (kind) => {
    if (soundsOn() && TONES[kind]) tone(TONES[kind]);
    window.kikDesk?.pulse?.(kind === "error" ? 0.3 : 0.6);
  };

  // --- menus -------------------------------------------------------------------------------
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.hidden = true;
  document.body.append(menu);
  function closeMenu() {
    menu.hidden = true;
  }
  function openMenu(x, y, entries) {
    menu.textContent = "";
    for (const e of entries) {
      if (e === "-") {
        menu.append(Object.assign(document.createElement("hr"), {}));
        continue;
      }
      const b = document.createElement("button");
      b.innerHTML = "<span></span><i></i>";
      b.firstChild.textContent = e.title;
      b.lastChild.textContent = e.keys ?? "";
      b.addEventListener("click", () => {
        closeMenu();
        window.kik.feel("act");
        e.run();
      });
      menu.append(b);
    }
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    window.kik.feel("menu");
  }
  addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !e.target.closest(".ctx-menu")) closeMenu();
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  const pinOf = (el) => window.kikPins?.get(el.dataset.id) ?? null;
  /** Ask Kik about a card: the palette in ask mode, with the card as context. */
  function askAbout(p) {
    window.kikPalette?.open(
      "ask",
      "",
      `About the ${p.kind} "${p.title || p.kind}" on the canvas (id ${p.id}):`,
    );
  }
  window.kik.askAbout = askAbout;
  window.kik.menu = openMenu;

  document.addEventListener("contextmenu", (e) => {
    const desk = e.target.closest("#desk");
    if (
      !desk ||
      e.target.closest("input, textarea, [contenteditable], .dk-hud button, .monaco-editor")
    )
      return;
    e.preventDefault();
    const card = e.target.closest(".pin");
    const area = e.target.closest(".area");
    const items = [];
    if (card) {
      const p = pinOf(card);
      if (p) {
        items.push({ title: "Ask Kik about this", keys: "drop on Kik", run: () => askAbout(p) });
        items.push({ title: "Zoom to it", run: () => window.board.focus(p.id) });
        items.push({
          title: p.sticky ? "Let it fade" : "Keep it",
          run: () => window.room.updatePin(p.id, { sticky: !p.sticky }),
        });
        if (p.body)
          items.push({
            title: "Copy its text",
            run: () => navigator.clipboard?.writeText(String(p.body)),
          });
        if (window.kik.cardActions) for (const a of window.kik.cardActions(p)) items.push(a);
        items.push("-");
        items.push({ title: "Dismiss", run: () => window.room.removePin(p.id) });
      }
    } else if (area) {
      const name = area.dataset.area;
      items.push({ title: `Fly to ${name}`, run: () => window.kikDesk?.go(name) });
      items.push({
        title: `Ask Kik about ${name}`,
        run: () => window.kikPalette?.open("ask", "", `About my ${name}:`),
      });
    }
    if (items.length) items.push("-");
    items.push({ title: "Command palette", keys: "Ctrl K", run: () => window.kikPalette?.open() });
    items.push({ title: "The whole desk", run: () => window.kikDesk?.go("all") });
    if (window.kik.canvasActions) for (const a of window.kik.canvasActions()) items.push(a);
    openMenu(e.clientX, e.clientY, items);
  });

  // --- a card dropped on the sphere is a question about it (board.js) -----------------------
  addEventListener("board:drop-on-kik", (e) => {
    const p = window.kikPins?.get(e.detail.id);
    if (!p) return;
    window.kik.feel("drop");
    askAbout(p);
  });
})();
