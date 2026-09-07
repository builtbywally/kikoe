// The board as a canvas: an infinite surface you pan and zoom, with one
// labelled frame per repo and pins you can drag. It is the agent's
// whiteboard, so nothing on it is editable; moving a pin is arranging, not
// editing.
//
// This file used to end that paragraph with "nothing here is persisted: the
// board is as ephemeral as speech", and that was true and deliberate. It
// stopped being true on 2026-09-07, when boards became per project: where you
// drag a card is now saved with it, so opening a project gives you back the
// arrangement you left. Layout is still derived for anything you have not
// touched — the difference is that a decision you made by hand survives.
//
// Exposes window.board = { render(pins), fit(), focus(id), reset(), zoomTo(k), zoom }.

(() => {
  const FRAME_W = 560;
  const FRAME_GAP = 80;
  const PIN_GAP = 18;
  const PAD = 24;
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 2.5;
  /** fit never shrinks below this: a board you cannot read is not a board */
  const FIT_FLOOR = 0.85;
  const TOP = 96;
  const LEFT = 72;

  const canvas = document.getElementById("board");
  const world = document.createElement("div");
  world.className = "world";
  canvas.append(world);

  const hud = document.createElement("div");
  hud.className = "zoom-hud";
  hud.innerHTML = "";
  const zOut = mk("button", "quiet", "−");
  const zLabel = mk("button", "quiet", "100%");
  const zIn = mk("button", "quiet", "+");
  const zFit = mk("button", "quiet", "fit");
  hud.append(zOut, zLabel, zIn, zFit);
  canvas.append(hud);

  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    e.className = cls;
    e.textContent = text;
    return e;
  }

  let zoom = 1;
  let panX = 0;
  let panY = 0;
  /** pin id -> { x, y } in world units */
  const positions = new Map();
  /** repo -> column index, stable for the session */
  const columns = new Map();
  let lastPins = [];

  function apply() {
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    canvas.style.backgroundPosition = `${panX}px ${panY}px`;
    const grid = Math.max(12, Math.round(28 * zoom));
    canvas.style.backgroundSize = `${grid}px ${grid}px`;
    zLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function zoomAt(k, cx, cy) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k));
    // Keep the point under the cursor fixed.
    panX = cx - ((cx - panX) * next) / zoom;
    panY = cy - ((cy - panY) * next) / zoom;
    zoom = next;
    apply();
  }

  function fit() {
    const rect = canvas.getBoundingClientRect();
    const frames = [...world.querySelectorAll(".frame")];
    if (!frames.length) {
      zoom = 1;
      panX = PAD;
      panY = PAD;
      return apply();
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const f of frames) {
      const x = Number.parseFloat(f.style.left);
      const y = Number.parseFloat(f.style.top);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y - 28);
      maxX = Math.max(maxX, x + f.offsetWidth);
      maxY = Math.max(maxY, y + f.offsetHeight);
    }
    const w = maxX - minX + PAD * 2;
    const h = maxY - minY + PAD * 2;
    zoom = Math.max(FIT_FLOOR, Math.min(1, (rect.width - LEFT * 2) / w, (rect.height - 300) / h));
    panX = LEFT - minX * zoom;
    panY = TOP - minY * zoom;
    apply();
  }

  // --- pan and zoom -------------------------------------------------------------

  let dragging = null;
  canvas.addEventListener("pointerdown", (e) => {
    const pin = e.target.closest(".pin");
    if (e.target.closest("button, a, select, input")) return;
    const start = { x: e.clientX, y: e.clientY, panX, panY };
    if (pin && e.button === 0) {
      const pos = positions.get(pin.dataset.id) ?? { x: 0, y: 0 };
      dragging = { kind: "pin", pin, start, from: { ...pos } };
      pin.classList.add("dragging");
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 0 || e.button === 1) {
      dragging = { kind: "pan", start };
      canvas.classList.add("panning");
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragging.start.x;
    const dy = e.clientY - dragging.start.y;
    if (dragging.kind === "pan") {
      panX = dragging.start.panX + dx;
      panY = dragging.start.panY + dy;
      apply();
    } else {
      const pos = { x: dragging.from.x + dx / zoom, y: dragging.from.y + dy / zoom };
      positions.set(dragging.pin.dataset.id, pos);
      moved.add(dragging.pin.dataset.id);
      dragging.pin.style.left = `${pos.x}px`;
      dragging.pin.style.top = `${pos.y}px`;
      layoutFrames();
    }
  });
  const endDrag = () => {
    if (dragging?.kind === "pin") {
      dragging.pin.classList.remove("dragging");
      // Where you put it is part of the board now. The grip has always saved
      // a size this way; a position is the same promise.
      const id = dragging.pin.dataset.id;
      const pos = positions.get(id);
      if (pos && !String(id).startsWith("conversation") && !LIVE.has(dragging.pin.dataset.kind)) {
        window.room.updatePin?.(id, { x: Math.round(pos.x), y: Math.round(pos.y) });
      }
    }
    canvas.classList.remove("panning");
    dragging = null;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        // Pinch on a trackpad arrives as ctrl+wheel. Zoom about the cursor.
        const k = zoom * Math.exp(-e.deltaY * 0.0022);
        zoomAt(k, e.clientX - rect.left, e.clientY - rect.top);
      } else {
        panX -= e.deltaX;
        panY -= e.deltaY;
        apply();
      }
    },
    { passive: false },
  );
  zIn.addEventListener("click", () =>
    zoomAt(zoom * 1.25, canvas.clientWidth / 2, canvas.clientHeight / 2),
  );
  zOut.addEventListener("click", () =>
    zoomAt(zoom / 1.25, canvas.clientWidth / 2, canvas.clientHeight / 2),
  );
  zLabel.addEventListener("click", () =>
    zoomAt(1, canvas.clientWidth / 2, canvas.clientHeight / 2),
  );
  zFit.addEventListener("click", fit);
  window.addEventListener("resize", () => {
    if (lastPins.length) fit();
  });

  // --- layout ---------------------------------------------------------------------

  function columnOf(repo) {
    if (!columns.has(repo)) columns.set(repo, columns.size);
    return columns.get(repo);
  }

  /** ids the user has dragged: auto layout never moves them again */
  const moved = new Set();

  /**
   * Give a new pin a place. A question goes to the top of its repo's column
   * and the auto-placed pins below shift down; anything else goes under
   * the last pin. Pins the user dragged stay where they were put.
   */
  function place(pin, el) {
    if (positions.has(pin.id)) return positions.get(pin.id);
    // A pin that remembers where it was put goes back there, and is never
    // laid out or settled again. This is what makes a board a workspace
    // rather than a whiteboard that forgets overnight.
    if (pin.x || pin.y) {
      const pos = { x: pin.x, y: pin.y };
      positions.set(pin.id, pos);
      moved.add(pin.id);
      return pos;
    }
    const col = columnOf(pin.repo || "");
    const x = col * (FRAME_W + FRAME_GAP);
    // A sticky beside its card: to the right of it, top aligned, out of the column flow.
    if (pin.near) {
      const host = world.querySelector(`.pin[data-id="${CSS.escape(pin.near)}"]`);
      const hp = positions.get(pin.near);
      if (host && hp) {
        const beside = lastPins.filter(
          (o) => o.near === pin.near && o.id !== pin.id && positions.has(o.id),
        );
        const pos = { x: hp.x + host.offsetWidth + 24, y: hp.y + beside.length * 140 };
        positions.set(pin.id, pos);
        return pos;
      }
    }
    const siblings = lastPins.filter(
      (o) => o.id !== pin.id && (o.repo || "") === (pin.repo || "") && !o.near,
    );
    const asking = pin.ask.length > 0 && pin.answer === null;
    if (asking && siblings.length) {
      const h = el.offsetHeight + PIN_GAP;
      for (const o of siblings) {
        if (moved.has(o.id)) continue;
        const p = positions.get(o.id);
        const oel = world.querySelector(`.pin[data-id="${o.id}"]`);
        if (!p || !oel) continue;
        p.y += h;
        oel.style.top = `${p.y}px`;
      }
      const pos = { x, y: 0 };
      positions.set(pin.id, pos);
      return pos;
    }
    let y = 0;
    for (const o of siblings) {
      const p = positions.get(o.id);
      const oel = world.querySelector(`.pin[data-id="${o.id}"]`);
      if (p && oel) y = Math.max(y, p.y + oel.offsetHeight + PIN_GAP);
    }
    const pos = { x, y };
    positions.set(pin.id, pos);
    return pos;
  }

  /** Frames wrap whatever pins sit in their column, wherever they were dragged. */
  function layoutFrames() {
    for (const frame of world.querySelectorAll(".frame")) {
      const repo = frame.dataset.repo;
      const pins = [...world.querySelectorAll(".pin")].filter(
        (p) => (p.dataset.repo || "") === repo,
      );
      if (!pins.length) {
        frame.remove();
        continue;
      }
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const p of pins) {
        const x = Number.parseFloat(p.style.left);
        const y = Number.parseFloat(p.style.top);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + p.offsetWidth);
        maxY = Math.max(maxY, y + p.offsetHeight);
      }
      frame.style.left = `${minX - PAD}px`;
      frame.style.top = `${minY - PAD}px`;
      frame.style.width = `${maxX - minX + PAD * 2}px`;
      frame.style.height = `${maxY - minY + PAD * 2}px`;
    }
  }

  /** what a card was last built from; unchanged cards are kept, so a live frame never reloads */
  const built = new Map();
  const LIVE = new Set(["conversation", "session", "agents", "events"]);
  function signature(pin) {
    return JSON.stringify([
      pin.kind,
      pin.title,
      pin.body,
      pin.ask,
      pin.answer,
      pin.sticky,
      pin.size,
      pin.near,
      pin.by,
      pin.wait_s,
      pin.updated,
    ]);
  }

  /**
   * Nothing on the canvas may sit on top of anything else. Cards the user
   * dragged stay put; every other card is walked in reading order and
   * pushed down until it clears whatever is already placed, including a
   * wide card reaching into the next column and a card that has grown.
   */
  function settle() {
    const els = [...world.querySelectorAll(".pin")]
      .map((el) => ({ el, id: el.dataset.id, pos: positions.get(el.dataset.id) }))
      .filter((c) => c.pos)
      .sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x);
    const placed = [];
    const hits = (r) =>
      placed.find((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
    for (const c of els) {
      const r = { x: c.pos.x, y: c.pos.y, w: c.el.offsetWidth, h: c.el.offsetHeight };
      const pin = lastPins.find((p) => p.id === c.id);
      if (!moved.has(c.id) && !pin?.near) {
        let guard = 0;
        let o = hits(r);
        while (o && guard++ < 64) {
          r.y = o.y + o.h + PIN_GAP;
          o = hits(r);
        }
        if (r.y !== c.pos.y) {
          c.pos.y = r.y;
          c.el.style.top = `${r.y}px`;
        }
      }
      placed.push(r);
    }
  }

  function render(pins, renderPin) {
    const first = lastPins.length === 0 && pins.length > 0;
    lastPins = pins;
    const keep = new Set(pins.map((p) => p.id));
    for (const el of world.querySelectorAll(".pin")) if (!keep.has(el.dataset.id)) el.remove();
    for (const id of [...positions.keys()]) if (!keep.has(id)) positions.delete(id);
    for (const id of [...built.keys()]) if (!keep.has(id)) built.delete(id);
    const repos = [...new Set(pins.map((p) => p.repo || ""))];
    for (const repo of repos) {
      if (!world.querySelector(`.frame[data-repo="${CSS.escape(repo)}"]`)) {
        const frame = document.createElement("div");
        frame.className = "frame";
        frame.dataset.repo = repo;
        const label = document.createElement("div");
        label.className = "frame-label";
        label.textContent = repo || "board";
        frame.append(label);
        world.append(frame);
      }
    }
    for (const pin of pins) {
      let el = world.querySelector(`.pin[data-id="${pin.id}"]`);
      const sig = signature(pin);
      const fresh = renderPin(pin);
      if (el && !LIVE.has(pin.kind) && built.get(pin.id) === sig) {
        // Same card: keep it (a page or a site inside stays put), refresh
        // only what time changes, the age and the fade.
        el.style.opacity = fresh.style.opacity;
        const age = el.querySelector(".pin-head .age");
        const freshAge = fresh.querySelector(".pin-head .age");
        if (age && freshAge) age.textContent = freshAge.textContent;
        // a new size (the grip, a viewport button) applies without a rebuild
        if (pin.w > 0) el.style.width = `${pin.w}px`;
        if (pin.h > 0) {
          el.style.height = `${pin.h}px`;
          el.style.maxHeight = "none";
        }
        const pos = place(pin, el);
        el.style.left = `${pos.x}px`;
        el.style.top = `${pos.y}px`;
        continue;
      }
      built.set(pin.id, sig);
      fresh.dataset.id = pin.id;
      fresh.dataset.repo = pin.repo || "";
      if (el) el.replaceWith(fresh);
      else world.append(fresh);
      el = fresh;
      el.style.width =
        pin.w > 0
          ? `${pin.w}px`
          : pin.size === "wide"
            ? `${FRAME_W * 2 + FRAME_GAP - PAD * 2}px`
            : pin.kind === "note"
              ? "260px"
              : `${FRAME_W - PAD * 2}px`;
      if (pin.h > 0) {
        el.style.height = `${pin.h}px`;
        el.style.maxHeight = "none";
      }
      el.dataset.size = pin.size || "normal";
      if (!el.querySelector(".grip")) {
        // canvas freedom: drag the corner to any size; it is remembered
        const grip = document.createElement("div");
        grip.className = "grip";
        grip.title = "resize";
        grip.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          e.preventDefault();
          const startX = e.clientX;
          const startY = e.clientY;
          const w0 = el.offsetWidth;
          const h0 = el.offsetHeight;
          el.style.maxHeight = "none";
          const move = (ev) => {
            const w = Math.max(200, Math.round(w0 + (ev.clientX - startX) / zoom));
            const h = Math.max(120, Math.round(h0 + (ev.clientY - startY) / zoom));
            el.style.width = `${w}px`;
            el.style.height = `${h}px`;
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            settle();
            layoutFrames();
            window.room.updatePin?.(pin.id, { w: el.offsetWidth, h: el.offsetHeight });
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        });
        el.append(grip);
      }
      const pos = place(pin, el);
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
    }
    settle();
    layoutFrames();
    if (first) fit();
    else apply();
  }

  /** Take the user to a card: pan it to the centre at a readable zoom, and pulse it. */
  function focus(id) {
    const el = world.querySelector(`.pin[data-id="${CSS.escape(id)}"]`);
    if (!el) return false;
    const k = Math.max(zoom, 1);
    const rect = canvas.getBoundingClientRect();
    const x = Number.parseFloat(el.style.left) || 0;
    const y = Number.parseFloat(el.style.top) || 0;
    const frame = el.closest(".frame");
    const fx = frame ? Number.parseFloat(frame.style.left) || 0 : 0;
    const fy = frame ? Number.parseFloat(frame.style.top) || 0 : 0;
    zoom = k;
    panX = rect.width / 2 - (fx + x + el.offsetWidth / 2) * k;
    panY = rect.height / 2 - (fy + y + Math.min(el.offsetHeight, 300) / 2) * k;
    apply();
    el.classList.remove("spot");
    void el.offsetWidth;
    el.classList.add("spot");
    setTimeout(() => el.classList.remove("spot"), 2600);
    return true;
  }

  /**
   * Another project's board. Everything the canvas remembers about this one
   * goes — positions, which cards the user arranged, the column each repo
   * was given — because none of it means anything on the next board, and a
   * stale column would put a new project's cards in a gap.
   */
  function reset() {
    positions.clear();
    moved.clear();
    columns.clear();
    built.clear();
    // `first` is derived from an empty lastPins, so clearing it is what makes
    // the next render fit the new board rather than keeping this one's view.
    lastPins = [];
    panX = 0;
    panY = 0;
    zoom = 1;
    for (const el of world.querySelectorAll(".pin, .frame")) el.remove();
    apply();
  }

  window.board = {
    render,
    fit,
    focus,
    reset,
    zoomTo: (k) => zoomAt(k, canvas.clientWidth / 2, canvas.clientHeight / 2),
    get zoom() {
      return zoom;
    },
  };
  apply();
})();
