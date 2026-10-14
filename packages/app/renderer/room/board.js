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
// Motion (2026-09-24): the camera glides to a card and to fit instead of
// jumping, a flung pan coasts to a stop, cards fade in when they arrive and
// out when they go, and a card the layout pushes aside slides there. All of it
// is transform and opacity, so it stays on the compositor, and none of it runs
// under prefers-reduced-motion or in a window nobody can see (the screenshot
// harness), where every change lands at once as before.
//
// Speed: a render reads every card's size once and writes every position
// once, instead of reading and writing card by card; cards that did not
// change are not rebuilt, not even to read their age; pan and zoom are
// painted once per frame however many events arrive.
//
// The desk (2026-10-14): this is no longer a screen of its own. It is the
// desk's camera: the world holds the desk's layers (the neuron sphere at
// 0,0, the five areas, from desk.js) and, at the Work origin, the work layer
// with Kik's cards in their repo columns. A card's saved x/y is relative to
// that origin, so every board saved before the desk opens as it was.
//
// Exposes window.board = { render(pins, build, fresh), fit(), focus(id),
// reset(), zoomTo(k), zoom, layer(name), flyTo(x, y, w, h), camera(), WORK }.

(() => {
  const FRAME_W = 560;
  const FRAME_GAP = 80;
  const PIN_GAP = 18;
  const PAD = 24;
  // the whole desk, from far enough out to see every area at once
  const MIN_ZOOM = 0.08;
  const MAX_ZOOM = 2.5;
  const LEFT = 72;
  /** the easing every glide shares: quick to start, soft to land */
  const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
  /** cards snap to this while dragged (Alt moves freely) */
  const GRID = 16;
  /** a card let go this close to the sphere's centre is a question for Kik */
  const KIK_R = 430;
  /** where Kik's cards begin on the desk: the Work area, below the sphere */
  const WORK = { x: -1300, y: 1380 };
  /** the room the desk's HUD takes: the header above, the dock and the line below */
  const HUD_TOP = 120;
  const HUD_BOTTOM = 190;

  const canvas = document.getElementById("board");
  const world = document.createElement("div");
  world.className = "world";
  canvas.append(world);
  // Kik's cards and their repo frames, offset to the Work area
  const work = document.createElement("div");
  work.className = "work-layer";
  work.style.left = `${WORK.x}px`;
  work.style.top = `${WORK.y}px`;
  world.append(work);

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

  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  /** Motion only where someone can see it, and wants it. */
  const moves = () => !calm?.matches && document.visibilityState === "visible";

  let zoom = 1;
  let panX = 0;
  let panY = 0;
  /** pin id -> { x, y } in world units */
  const positions = new Map();
  /** repo -> column index, stable for the session */
  const columns = new Map();
  /** pin id -> its element, so nothing has to search the DOM for a card */
  const els = new Map();
  /** pin id -> { w, h }, measured once per render */
  const sizes = new Map();
  let lastPins = [];
  let byId = new Map();

  // --- the camera -------------------------------------------------------------------

  let lastZoomLabel = "";
  function paint() {
    world.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
    const label = `${Math.round(zoom * 100)}%`;
    if (label !== lastZoomLabel) {
      lastZoomLabel = label;
      zLabel.textContent = label;
    }
  }

  // Pointer and wheel events can arrive several times a frame; the camera is
  // painted once per frame, with whatever the last of them said.
  let frame = 0;
  function apply() {
    if (!moves()) {
      paint();
      return;
    }
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
    busy();
  }
  /** The camera now, for anything that measures straight after (fit, the harness). */
  function applyNow() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    paint();
  }

  // While the canvas moves, the expensive looks come off: a frosted card
  // re-blurs whatever is behind it on every frame. `moving` is dropped a
  // moment after the last movement.
  let idle = 0;
  function busy() {
    canvas.classList.add("moving");
    clearTimeout(idle);
    idle = setTimeout(() => canvas.classList.remove("moving"), 160);
  }

  function clampZoom(k) {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k));
  }

  function zoomAt(k, cx, cy) {
    const next = clampZoom(k);
    // Keep the point under the cursor fixed.
    panX = cx - ((cx - panX) * next) / zoom;
    panY = cy - ((cy - panY) * next) / zoom;
    zoom = next;
    apply();
  }

  // A glide from where the camera is to where it should be. Any touch of the
  // canvas takes the camera back at once.
  let glide = 0;
  function stopGlide() {
    if (glide) cancelAnimationFrame(glide);
    glide = 0;
  }
  function glideTo(k, x, y, ms = 420) {
    stopGlide();
    stopCoast();
    if (!moves()) {
      zoom = k;
      panX = x;
      panY = y;
      return applyNow();
    }
    const from = { k: zoom, x: panX, y: panY };
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - t) ** 3;
      zoom = from.k + (k - from.k) * e;
      panX = from.x + (x - from.x) * e;
      panY = from.y + (y - from.y) * e;
      paint();
      busy();
      glide = t < 1 ? requestAnimationFrame(step) : 0;
    };
    glide = requestAnimationFrame(step);
  }
  /** Zoom about a point, gliding. */
  function glideZoomAt(k, cx, cy) {
    const next = clampZoom(k);
    glideTo(next, cx - ((cx - panX) * next) / zoom, cy - ((cy - panY) * next) / zoom, 260);
  }

  // A pan let go of at speed keeps going and slows, the way a sheet of paper
  // slides on a desk. Velocity is measured over the last few moves.
  let coast = 0;
  function stopCoast() {
    if (coast) cancelAnimationFrame(coast);
    coast = 0;
  }
  function coastFrom(vx0, vy0) {
    stopCoast();
    if (!moves() || Math.hypot(vx0, vy0) < 0.25) return;
    let vx = vx0;
    let vy = vy0;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - last);
      last = now;
      panX += vx * dt;
      panY += vy * dt;
      // time-based friction, so a slow frame does not make it slide further
      const decay = Math.exp(-dt / 280);
      vx *= decay;
      vy *= decay;
      paint();
      busy();
      coast = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    coast = requestAnimationFrame(step);
  }

  /** A world rectangle for anything on the desk: an area, the sphere, a card's frame. */
  function worldRect(el) {
    const inWork = work.contains(el);
    return {
      x: Number.parseFloat(el.style.left) + (inWork ? WORK.x : 0),
      y: Number.parseFloat(el.style.top) + (inWork ? WORK.y : 0),
      w: el.offsetWidth,
      h: el.offsetHeight,
    };
  }
  /** The camera that shows a world rectangle between the HUD's header and its dock. */
  function viewOf(x, y, w, h, maxK = 1) {
    const rect = canvas.getBoundingClientRect();
    const phone = document.documentElement.dataset.phone === "true";
    const top = phone ? 150 : HUD_TOP;
    const bottom = phone ? 230 : HUD_BOTTOM;
    const side = phone ? 12 : LEFT;
    const k = Math.max(
      MIN_ZOOM,
      Math.min(maxK, (rect.width - side * 2) / w, (rect.height - top - bottom) / h),
    );
    return {
      k,
      x: rect.width / 2 - (x + w / 2) * k,
      y: top + (rect.height - top - bottom) / 2 - (y + h / 2) * k,
    };
  }
  /**
   * Where the camera would be to show the whole desk: the sphere, the five
   * areas and Kik's cards. On a phone, the Home area, read at full width;
   * the rest is a swipe or the dock away.
   */
  function fitView() {
    const parts = [...world.querySelectorAll(".area, .dk-world-sphere, .work-layer .frame")];
    if (document.documentElement.dataset.phone === "true") {
      const home = world.querySelector('.area[data-area="home"]');
      if (home) {
        const r = worldRect(home);
        return viewOf(r.x, r.y - 30, r.w, r.h + 30);
      }
    }
    if (!parts.length) return { k: 1, x: PAD, y: PAD };
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const f of parts) {
      const r = worldRect(f);
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y - 30);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    return viewOf(minX - PAD, minY - PAD, maxX - minX + PAD * 2, maxY - minY + PAD * 2);
  }
  /** Show the board. Gliding when asked for; at once when a board first appears. */
  function fit(animate = true) {
    const v = fitView();
    if (animate) glideTo(v.k, v.x, v.y);
    else {
      stopGlide();
      zoom = v.k;
      panX = v.x;
      panY = v.y;
      applyNow();
    }
  }

  // --- pan and zoom -------------------------------------------------------------

  let dragging = null;
  /** cards picked with shift-click: they move together */
  const selected = new Set();
  function select(id, on) {
    if (on) selected.add(id);
    else selected.delete(id);
    els.get(id)?.classList.toggle("selected", on);
  }
  function clearSelection() {
    for (const id of [...selected]) select(id, false);
  }
  // Two fingers are a pinch: zoom about the point between them, and pan with
  // it. Tracked here because pointer events arrive one finger at a time.
  const fingers = new Map();
  let pinch = null;
  const between = () => {
    const [a, b] = [...fingers.values()];
    const rect = canvas.getBoundingClientRect();
    return {
      d: Math.hypot(a.x - b.x, a.y - b.y),
      x: (a.x + b.x) / 2 - rect.left,
      y: (a.y + b.y) / 2 - rect.top,
    };
  };
  // A viewer (the phone, a second screen) cannot move a card, so a finger on
  // one pans the canvas instead of failing to drag it.
  const readOnly = () => document.documentElement.dataset.readonly === "true";
  /** the last few pan samples, for the speed a fling leaves with */
  let trail = [];

  // Touch, the way a map on a web page works (2026-09-24, from the phone: "I
  // can't move the screen or things easily"). On a phone the cards fill the
  // screen and most of them are live pages, and a finger that landed on one
  // went into the page, so the canvas would not move. Now a finger anywhere
  // moves the canvas; a tap on a card makes it the one in use (its page
  // takes touches, a long card scrolls under the finger) until a tap on the
  // canvas lets it go; a double tap on the canvas zooms in, and out again.
  /** the id of the card in use; an id, since a live card is rebuilt on every update */
  let liveId = "";
  /** a touch that has not moved yet: a tap if it lifts soon */
  let tap = null;
  let lastTap = null;
  function setLive(pin) {
    const id = pin?.dataset.id ?? "";
    if (liveId === id) return;
    els.get(liveId)?.classList.remove("live");
    liveId = id;
    els.get(liveId)?.classList.add("live");
  }
  canvas.addEventListener("pointerdown", (e) => {
    stopGlide();
    stopCoast();
    const pin = e.target.closest(".pin");
    if (e.target.closest("button, a, select, input, textarea")) return;
    if (e.pointerType === "touch") {
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (fingers.size === 2) {
        if (dragging?.kind === "pin") dragging.pin.classList.remove("dragging");
        dragging = null;
        tap = null;
        pinch = between();
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      tap = { x: e.clientX, y: e.clientY, t: performance.now(), pin };
      // The card in use: its own content takes the finger. A long one
      // scrolls; anything else (buttons, its page) is its to handle.
      if (pin && pin.dataset.id === liveId) {
        const body = e.target.closest(".pin-body");
        if (body && body.scrollHeight > body.clientHeight + 2) {
          dragging = {
            kind: "scroll",
            body,
            start: { x: e.clientX, y: e.clientY, top: body.scrollTop },
          };
          canvas.setPointerCapture(e.pointerId);
        }
        return;
      }
    }
    const start = { x: e.clientX, y: e.clientY, panX, panY };
    if (pin && e.button === 0 && !readOnly()) {
      const id = pin.dataset.id;
      // shift-click picks cards; the picked ones move together
      if (e.shiftKey) {
        select(id, !selected.has(id));
        return;
      }
      if (!selected.has(id)) clearSelection();
      const pos = positions.get(id) ?? { x: 0, y: 0 };
      measure();
      const group = [...selected]
        .filter((o) => o !== id && els.has(o))
        .map((o) => ({ id: o, el: els.get(o), from: { ...(positions.get(o) ?? { x: 0, y: 0 }) } }));
      dragging = { kind: "pin", pin, id, start, from: { ...pos }, group };
      pin.classList.add("dragging");
      canvas.classList.add("arranging");
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 0 || e.button === 1) {
      if (!e.shiftKey) clearSelection();
      dragging = { kind: "pan", start };
      trail = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
      canvas.classList.add("panning");
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && fingers.size === 2) {
      const now = between();
      panX += now.x - pinch.x;
      panY += now.y - pinch.y;
      if (pinch.d > 0) zoomAt(zoom * (now.d / pinch.d), now.x, now.y);
      else apply();
      pinch = now;
      return;
    }
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) tap = null;
    if (!dragging) return;
    const dx = e.clientX - dragging.start.x;
    const dy = e.clientY - dragging.start.y;
    if (dragging.kind === "scroll") {
      dragging.body.scrollTop = dragging.start.top - dy;
      return;
    }
    if (dragging.kind === "pan") {
      panX = dragging.start.panX + dx;
      panY = dragging.start.panY + dy;
      const t = performance.now();
      trail.push({ x: e.clientX, y: e.clientY, t });
      while (trail.length > 2 && t - trail[0].t > 80) trail.shift();
      apply();
    } else {
      // to the grid, unless Alt is held
      const snap = (v) => (e.altKey ? v : Math.round(v / GRID) * GRID);
      const ddx = snap(dragging.from.x + dx / zoom) - dragging.from.x;
      const ddy = snap(dragging.from.y + dy / zoom) - dragging.from.y;
      const pos = { x: dragging.from.x + ddx, y: dragging.from.y + ddy };
      positions.set(dragging.id, pos);
      moved.add(dragging.id);
      dragging.pin.style.left = `${pos.x}px`;
      dragging.pin.style.top = `${pos.y}px`;
      for (const g of dragging.group) {
        const gp = { x: g.from.x + ddx, y: g.from.y + ddy };
        positions.set(g.id, gp);
        moved.add(g.id);
        g.el.style.left = `${gp.x}px`;
        g.el.style.top = `${gp.y}px`;
      }
      // over Kik: the sphere answers before it is let go
      canvas.classList.toggle("over-kik", overKik(dragging.id));
      if (dragging.group.length) layoutFrames();
      // Only the frame this card is in can change, and every size is already
      // known: no layout is forced while a card is in the hand.
      else layoutFrames(dragging.pin.dataset.repo || "");
    }
  });
  /** Is this card's centre over Kik's sphere (the world's centre)? */
  function overKik(id) {
    const p = positions.get(id);
    if (!p) return false;
    const s = sizeOf(id);
    return Math.hypot(WORK.x + p.x + s.w / 2, WORK.y + p.y + Math.min(s.h, 300) / 2) < KIK_R;
  }
  const endDrag = () => {
    if (dragging?.kind === "pin") {
      dragging.pin.classList.remove("dragging");
      canvas.classList.remove("arranging", "over-kik");
      const id = dragging.id;
      // Let go over Kik: the card goes back where it was, and is a question.
      if (overKik(id)) {
        for (const g of [{ id, el: dragging.pin, from: dragging.from }, ...dragging.group]) {
          positions.set(g.id, { ...g.from });
          g.el.style.left = `${g.from.x}px`;
          g.el.style.top = `${g.from.y}px`;
        }
        layoutFrames();
        window.dispatchEvent(new CustomEvent("board:drop-on-kik", { detail: { id } }));
        dragging = null;
        return;
      }
      // Where you put it is part of the board now. The grip has always saved
      // a size this way; a position is the same promise.
      for (const g of [{ id, el: dragging.pin }, ...dragging.group]) {
        const pos = positions.get(g.id);
        if (pos && !String(g.id).startsWith("conversation") && !LIVE.has(g.el.dataset.kind)) {
          window.room.updatePin?.(g.id, { x: Math.round(pos.x), y: Math.round(pos.y) });
        }
      }
    }
    if (dragging?.kind === "pan" && trail.length > 1) {
      const a = trail[0];
      const b = trail[trail.length - 1];
      const dt = b.t - a.t;
      // a pan that stopped before it was let go does not coast
      if (dt > 0 && performance.now() - b.t < 60) coastFrom((b.x - a.x) / dt, (b.y - a.y) / dt);
    }
    trail = [];
    canvas.classList.remove("panning");
    dragging = null;
  };
  const lift = (e) => {
    fingers.delete(e.pointerId);
    if (pinch) {
      // Lifting one finger of a pinch ends it; the other does not start a pan
      // from where the pinch left it, which would jump.
      if (fingers.size < 2) pinch = null;
      return;
    }
    endDrag();
    const t = tap;
    tap = null;
    if (!t || e.type !== "pointerup" || performance.now() - t.t > 350) return;
    if (t.pin) {
      setLive(t.pin);
      lastTap = null;
      return;
    }
    // a tap on the canvas lets the card in use go; two of them zoom
    setLive(null);
    const now = performance.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(t.x - lastTap.x, t.y - lastTap.y) < 40) {
      lastTap = null;
      const rect = canvas.getBoundingClientRect();
      if (zoom < 0.95) glideZoomAt(Math.min(1.4, zoom * 1.8), t.x - rect.left, t.y - rect.top);
      else fit(true);
      return;
    }
    lastTap = { x: t.x, y: t.y, t: now };
  };
  canvas.addEventListener("pointerup", lift);
  canvas.addEventListener("pointercancel", lift);
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      stopGlide();
      stopCoast();
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
  const centre = () => [canvas.clientWidth / 2, canvas.clientHeight / 2];
  zIn.addEventListener("click", () => glideZoomAt(zoom * 1.25, ...centre()));
  zOut.addEventListener("click", () => glideZoomAt(zoom / 1.25, ...centre()));
  zLabel.addEventListener("click", () => glideZoomAt(1, ...centre()));
  zFit.addEventListener("click", () => fit(true));
  let resizing = 0;
  window.addEventListener("resize", () => {
    // a window being dragged wider fires this dozens of times; fit once it rests
    clearTimeout(resizing);
    resizing = setTimeout(() => fit(false), 120);
  });

  // --- layout ---------------------------------------------------------------------

  function columnOf(repo) {
    if (!columns.has(repo)) columns.set(repo, columns.size);
    return columns.get(repo);
  }

  /** ids the user has dragged: auto layout never moves them again */
  const moved = new Set();

  /** Every card's size, read in one pass: one layout, however many cards. */
  function measure() {
    sizes.clear();
    for (const [id, el] of els) sizes.set(id, { w: el.offsetWidth, h: el.offsetHeight });
  }
  const sizeOf = (id) => sizes.get(id) ?? { w: 0, h: 0 };

  /**
   * Give a new pin a place. A question goes to the top of its repo's column
   * and the auto-placed pins below shift down; anything else goes under
   * the last pin. Pins the user dragged stay where they were put.
   */
  function place(pin) {
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
      const hp = positions.get(pin.near);
      if (els.has(pin.near) && hp) {
        const beside = lastPins.filter(
          (o) => o.near === pin.near && o.id !== pin.id && positions.has(o.id),
        );
        const pos = { x: hp.x + sizeOf(pin.near).w + 24, y: hp.y + beside.length * 140 };
        positions.set(pin.id, pos);
        return pos;
      }
    }
    const siblings = lastPins.filter(
      (o) => o.id !== pin.id && (o.repo || "") === (pin.repo || "") && !o.near,
    );
    const asking = pin.ask.length > 0 && pin.answer === null;
    if (asking && siblings.length) {
      const h = sizeOf(pin.id).h + PIN_GAP;
      for (const o of siblings) {
        if (moved.has(o.id)) continue;
        const p = positions.get(o.id);
        if (p && els.has(o.id)) p.y += h;
      }
      const pos = { x, y: 0 };
      positions.set(pin.id, pos);
      return pos;
    }
    let y = 0;
    for (const o of siblings) {
      const p = positions.get(o.id);
      if (p && els.has(o.id)) y = Math.max(y, p.y + sizeOf(o.id).h + PIN_GAP);
    }
    const pos = { x, y };
    positions.set(pin.id, pos);
    return pos;
  }

  /**
   * Frames wrap whatever pins sit in their column, wherever they were dragged.
   * From positions and measured sizes, never from the DOM. `only` limits it to
   * one repo's frame (a drag moves one card).
   */
  function layoutFrames(only) {
    const bounds = new Map();
    for (const [id, el] of els) {
      const repo = el.dataset.repo || "";
      if (only !== undefined && repo !== only) continue;
      const p = positions.get(id);
      if (!p) continue;
      const s = sizeOf(id);
      const b = bounds.get(repo) ?? { x0: p.x, y0: p.y, x1: p.x + s.w, y1: p.y + s.h };
      b.x0 = Math.min(b.x0, p.x);
      b.y0 = Math.min(b.y0, p.y);
      b.x1 = Math.max(b.x1, p.x + s.w);
      b.y1 = Math.max(b.y1, p.y + s.h);
      bounds.set(repo, b);
    }
    for (const frame of work.querySelectorAll(".frame")) {
      const repo = frame.dataset.repo;
      if (only !== undefined && repo !== only) continue;
      const b = bounds.get(repo);
      if (!b) {
        frame.remove();
        continue;
      }
      frame.style.left = `${b.x0 - PAD}px`;
      frame.style.top = `${b.y0 - PAD}px`;
      frame.style.width = `${b.x1 - b.x0 + PAD * 2}px`;
      frame.style.height = `${b.y1 - b.y0 + PAD * 2}px`;
    }
  }

  /** what a card was last built from; unchanged cards are kept, so a live frame never reloads */
  const built = new Map();
  const LIVE = new Set(["conversation", "session", "agents", "events"]);
  function signature(pin) {
    // A web card is a browser: moving it, resizing it, keeping it, a new
    // title or a new address from Kik are patched onto the live page (the
    // `patch` hook), never a rebuild that reloads it and loses where the
    // user had browsed to. Every drag used to do exactly that.
    if (pin.kind === "web") return JSON.stringify([pin.kind, pin.ask, pin.answer, pin.by]);
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
   * Positions only; the writes happen once, after.
   */
  function settle() {
    const cards = [...els.keys()]
      .map((id) => ({ id, pos: positions.get(id) }))
      .filter((c) => c.pos)
      .sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x);
    const placed = [];
    const hits = (r) =>
      placed.find((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
    for (const c of cards) {
      const s = sizeOf(c.id);
      const r = { x: c.pos.x, y: c.pos.y, w: s.w, h: s.h };
      if (!moved.has(c.id) && !byId.get(c.id)?.near) {
        let guard = 0;
        let o = hits(r);
        while (o && guard++ < 64) {
          r.y = o.y + o.h + PIN_GAP;
          o = hits(r);
        }
        c.pos.y = r.y;
      }
      placed.push(r);
    }
  }

  /** A card that is going: out, softly, and then gone. */
  function leave(el) {
    el.dataset.leaving = "1";
    el.style.pointerEvents = "none";
    if (!moves() || !el.animate) return el.remove();
    const a = el.animate([{ opacity: 0, transform: "scale(0.96)" }], {
      duration: 200,
      easing: "ease-in",
      fill: "forwards",
    });
    a.onfinish = () => el.remove();
  }

  function render(pins, renderPin, fresh, patch) {
    const first = lastPins.length === 0 && pins.length > 0;
    lastPins = pins;
    byId = new Map(pins.map((p) => [p.id, p]));
    for (const [id, el] of els) {
      if (byId.has(id)) continue;
      els.delete(id);
      leave(el);
    }
    for (const id of [...positions.keys()]) if (!byId.has(id)) positions.delete(id);
    for (const id of [...built.keys()]) if (!byId.has(id)) built.delete(id);
    const repos = new Set(pins.map((p) => p.repo || ""));
    const haveFrames = new Set([...work.querySelectorAll(".frame")].map((f) => f.dataset.repo));
    for (const repo of repos) {
      if (haveFrames.has(repo)) continue;
      const frame = document.createElement("div");
      frame.className = "frame";
      frame.dataset.repo = repo;
      const label = document.createElement("div");
      label.className = "frame-label";
      label.textContent = repo || "board";
      frame.append(label);
      work.append(frame);
    }

    // Where every card was, to slide the ones the layout moves.
    const before = new Map();
    for (const [id, p] of positions) before.set(id, { x: p.x, y: p.y });
    const arrived = [];

    /** where a rebuilt card's scrolled parts were, carried to the new card */
    let scrolled = [];
    // 1. build what changed; keep what did not
    for (const pin of pins) {
      const el = els.get(pin.id);
      const sig = signature(pin);
      if (el && !LIVE.has(pin.kind) && built.get(pin.id) === sig) {
        // Same card: keep it (a page or a site inside stays put), refresh
        // only what time changes, the age and the fade.
        const f = fresh ? fresh(pin) : null;
        if (f) {
          if (el.style.opacity !== f.opacity) el.style.opacity = f.opacity;
          const age = el.querySelector(".pin-head .age");
          if (age && age.textContent !== f.age) age.textContent = f.age;
        }
        // what changed on a kept card, patched in place (a web card's title,
        // its keep button, a new address to load)
        if (patch) patch(el, pin);
        // a new size (the grip, a viewport button) applies without a rebuild
        if (pin.w > 0) el.style.width = `${pin.w}px`;
        if (pin.h > 0) {
          el.style.height = `${pin.h}px`;
          el.style.maxHeight = "none";
        }
        continue;
      }
      built.set(pin.id, sig);
      const next = renderPin(pin);
      next.dataset.id = pin.id;
      next.dataset.repo = pin.repo || "";
      if (el) {
        // a rebuilt card keeps its place on screen while its insides change
        next.style.left = el.style.left;
        next.style.top = el.style.top;
        scrolled = scrollsOf(el);
        el.replaceWith(next);
      } else {
        scrolled = [];
        work.append(next);
        arrived.push(next);
      }
      els.set(pin.id, next);
      size(next, pin);
      grip(next, pin);
      // after sizing: at another width the text wraps to another height
      keepScrolls(next, scrolled);
    }

    // 2. read every size at once, 3. place and settle in memory, 4. write once
    measure();
    for (const pin of pins) place(pin);
    settle();
    for (const [id, el] of els) {
      const p = positions.get(id);
      if (!p) continue;
      const left = `${p.x}px`;
      const top = `${p.y}px`;
      if (el.style.left !== left) el.style.left = left;
      if (el.style.top !== top) el.style.top = top;
    }
    layoutFrames();
    apply();
    // the card in use stays in use through a rebuild, and is let go if it went
    if (liveId && !els.has(liveId)) liveId = "";
    els.get(liveId)?.classList.add("live");

    if (!moves() || first) return;
    // New cards arrive; cards the layout pushed aside slide to where they are.
    for (const el of arrived) {
      el.animate?.([{ opacity: 0, transform: "translateY(14px) scale(0.97)" }, {}], {
        duration: 360,
        easing: EASE,
      });
    }
    for (const [id, el] of els) {
      if (arrived.includes(el) || dragging?.id === id) continue;
      const a = before.get(id);
      const b = positions.get(id);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: 380,
        easing: EASE,
      });
    }
  }

  // A live card (the conversation, the agent's thread) is rebuilt on every
  // update, and a rebuilt card used to open at the top: scroll down, and a
  // second later it sprang back (the user, 2026-09-24). Where each scrolled
  // part of the old card was is carried to the same part of the new one; one
  // that was at the bottom stays at the bottom, so new lines stay in view.
  const SCROLLERS = ".pin-body, .pin-body *";
  function scrollsOf(el) {
    const out = [];
    const all = el.querySelectorAll(SCROLLERS);
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      if (s.scrollHeight <= s.clientHeight + 1) continue;
      out.push({
        i,
        top: s.scrollTop,
        bottom: s.scrollTop + s.clientHeight >= s.scrollHeight - 4,
      });
    }
    return out;
  }
  function keepScrolls(el, scrolls) {
    if (!scrolls.length) return;
    const all = el.querySelectorAll(SCROLLERS);
    for (const s of scrolls) {
      const t = all[s.i];
      if (!t) continue;
      t.scrollTop = s.bottom && s.top > 0 ? t.scrollHeight : s.top;
    }
  }

  /** A card's width and height, from what it is or what it was set to. */
  function size(el, pin) {
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
  }

  /** canvas freedom: drag the corner to any size; it is remembered */
  function grip(el, pin) {
    if (el.querySelector(".grip")) return;
    const g = document.createElement("div");
    g.className = "grip";
    g.title = "resize";
    g.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const w0 = el.offsetWidth;
      const h0 = el.offsetHeight;
      el.style.maxHeight = "none";
      let pending = null;
      let raf = 0;
      const move = (ev) => {
        pending = ev;
        // one resize per frame, not per mouse event
        if (!raf)
          raf = requestAnimationFrame(() => {
            raf = 0;
            if (!pending) return;
            const w = Math.max(200, Math.round(w0 + (pending.clientX - startX) / zoom));
            const h = Math.max(120, Math.round(h0 + (pending.clientY - startY) / zoom));
            el.style.width = `${w}px`;
            el.style.height = `${h}px`;
          });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (raf) cancelAnimationFrame(raf);
        if (pending) {
          el.style.width = `${Math.max(200, Math.round(w0 + (pending.clientX - startX) / zoom))}px`;
          el.style.height = `${Math.max(120, Math.round(h0 + (pending.clientY - startY) / zoom))}px`;
        }
        measure();
        settle();
        for (const [id, card] of els) {
          const p = positions.get(id);
          if (p) card.style.top = `${p.y}px`;
        }
        layoutFrames();
        window.room.updatePin?.(pin.id, { w: el.offsetWidth, h: el.offsetHeight });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    el.append(g);
  }

  /** Take the user to a card: glide it to the centre at a readable zoom, and pulse it. */
  function focus(id) {
    const el = els.get(id);
    if (!el) return false;
    const k = Math.max(zoom, 1);
    const rect = canvas.getBoundingClientRect();
    const p = positions.get(id) ?? { x: 0, y: 0 };
    const s = sizeOf(id).w ? sizeOf(id) : { w: el.offsetWidth, h: el.offsetHeight };
    // a card's place is in the Work area's frame of reference
    glideTo(
      k,
      rect.width / 2 - (WORK.x + p.x + s.w / 2) * k,
      rect.height / 2 - (WORK.y + p.y + Math.min(s.h, 300) / 2) * k,
    );
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
    stopGlide();
    stopCoast();
    positions.clear();
    moved.clear();
    columns.clear();
    built.clear();
    els.clear();
    sizes.clear();
    // `first` is derived from an empty lastPins, so clearing it is what makes
    // the next render fit the new board rather than keeping this one's view.
    lastPins = [];
    byId = new Map();
    panX = 0;
    panY = 0;
    zoom = 1;
    for (const el of work.querySelectorAll(".pin, .frame")) el.remove();
    fit(false);
  }

  /** A layer of the world for the desk (the sphere, the areas), under the cards. */
  function layer(name) {
    let el = world.querySelector(`:scope > .layer-${name}`);
    if (!el) {
      el = document.createElement("div");
      el.className = `layer layer-${name}`;
      world.insertBefore(el, work);
    }
    return el;
  }

  window.board = {
    render,
    fit,
    focus,
    reset,
    layer,
    WORK,
    zoomTo: (k) => glideZoomAt(k, ...centre()),
    /** Fly the camera to a world rectangle, framed between the HUD's header and dock. */
    flyTo(x, y, w, h, maxK = 1) {
      const v = viewOf(x, y, w, h, maxK);
      glideTo(v.k, v.x, v.y, 520);
    },
    /** The camera, for anything drawn in world space (the sphere). */
    camera: () => ({ x: panX, y: panY, zoom, w: canvas.clientWidth, h: canvas.clientHeight }),
    worldRect,
    get zoom() {
      return zoom;
    },
  };
  applyNow();
})();
