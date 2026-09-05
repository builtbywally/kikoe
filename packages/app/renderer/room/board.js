// The board as a canvas: an infinite surface you pan and zoom, with one
// labelled frame per repo and pins you can drag. It is the agent's
// whiteboard, so nothing on it is editable; moving a pin is arranging, not
// editing. Nothing here is persisted: the board is as ephemeral as speech.
//
// Exposes window.board = { render(pins), fit(), zoomTo(k), zoom }.

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
    zoom = Math.max(FIT_FLOOR, Math.min(1, (rect.width - LEFT * 2) / w, (rect.height - 230) / h));
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
    if (dragging?.kind === "pin") dragging.pin.classList.remove("dragging");
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
    const col = columnOf(pin.repo || "");
    const x = col * (FRAME_W + FRAME_GAP);
    const siblings = lastPins.filter((o) => o.id !== pin.id && (o.repo || "") === (pin.repo || ""));
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

  function render(pins, renderPin) {
    const first = lastPins.length === 0 && pins.length > 0;
    lastPins = pins;
    const keep = new Set(pins.map((p) => p.id));
    for (const el of world.querySelectorAll(".pin")) if (!keep.has(el.dataset.id)) el.remove();
    for (const id of [...positions.keys()]) if (!keep.has(id)) positions.delete(id);
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
      const fresh = renderPin(pin);
      fresh.dataset.id = pin.id;
      fresh.dataset.repo = pin.repo || "";
      if (el) el.replaceWith(fresh);
      else world.append(fresh);
      el = fresh;
      el.style.width = `${FRAME_W - PAD * 2}px`;
      const pos = place(pin, el);
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
    }
    layoutFrames();
    if (first) fit();
    else apply();
  }

  window.board = {
    render,
    fit,
    zoomTo: (k) => zoomAt(k, canvas.clientWidth / 2, canvas.clientHeight / 2),
    get zoom() {
      return zoom;
    },
  };
  apply();
})();
