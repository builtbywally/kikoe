// The holo keyboard (KARA-PLAN phase 5): K.A.R.A's curved command keyboard
// on a tablet, for Kik. Three arcs of letters, a ring of command keys inside
// them, and the KIK key at the centre.
//
// Letters build a line that RETURN sends to Kik (as if typed on the canvas).
// Command keys send Kik a short instruction; ROOM, DESK and BODY switch the
// computer's view; KIK opens push to talk on the computer's mic; CLEAR clears
// the board. Kik's last spoken line shows at the top.
//
// Served from the Room's folder: on the walkie (the phone's HTTPS link) it
// rides the walkie's cookie; on the computer, …/room/keys.html?token=<full>.
(() => {
  const q = new URLSearchParams(location.search);
  const token = q.get("token") || "";
  const headers = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const post = (path, body) =>
    fetch(path, { method: "POST", headers, body: JSON.stringify(body), credentials: "same-origin" })
      .then((r) => r.ok)
      .catch(() => false);

  const svg = document.getElementById("keys");
  const lineEl = document.getElementById("line-text");
  const saidEl = document.getElementById("said-text");
  const statusEl = document.getElementById("status");
  let line = "";
  let shift = false;

  // --- geometry: keys as sectors of rings around a centre below the board ----
  const NS = "http://www.w3.org/2000/svg";
  const deg = (a) => (a * Math.PI) / 180;
  const pt = (r, a) => [r * Math.cos(deg(a)), -r * Math.sin(deg(a))];
  function sector(r0, r1, a0, a1) {
    const [x0, y0] = pt(r1, a0);
    const [x1, y1] = pt(r1, a1);
    const [x2, y2] = pt(r0, a1);
    const [x3, y3] = pt(r0, a0);
    const big = Math.abs(a1 - a0) > 180 ? 1 : 0;
    return `M${x0},${y0}A${r1},${r1} 0 ${big} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${big} 0 ${x3},${y3}Z`;
  }
  function key(r0, r1, a0, a1, label, act, cls = "") {
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", `hk-key ${cls}`);
    g.dataset.act = act;
    const p = document.createElementNS(NS, "path");
    // a hair of gap between keys
    p.setAttribute("d", sector(r0 + 2, r1 - 2, a0 - 0.6, a1 + 0.6));
    const t = document.createElementNS(NS, "text");
    const [x, y] = pt((r0 + r1) / 2, (a0 + a1) / 2);
    t.setAttribute("x", x);
    t.setAttribute("y", y);
    t.setAttribute("transform", `rotate(${90 - (a0 + a1) / 2} ${x} ${y})`);
    t.textContent = label;
    g.append(p, t);
    svg.append(g);
    return g;
  }
  // a row of keys spread across an arc, left to right (angles fall as x rises)
  function row(r0, r1, from, to, items, cls) {
    const span = (from - to) / items.length;
    items.forEach(([label, act], i) =>
      key(r0, r1, from - (i + 1) * span, from - i * span, label, act, cls),
    );
  }
  function draw() {
    svg.textContent = "";
    const L = (s) =>
      [...s].map((c) => [shift ? c : c.toLowerCase(), `ch:${shift ? c : c.toLowerCase()}`]);
    row(400, 460, 160, 20, L("QWERTYUIOP"), "letter");
    row(340, 400, 155, 25, L("ASDFGHJKL"), "letter");
    row(280, 340, 150, 30, [["⇧", "shift"], ...L("ZXCVBNM"), ["del", "back"]], "letter");
    row(
      220,
      280,
      145,
      35,
      [
        ["?", "ch:?"],
        [",", "ch:,"],
        ["space", "ch: "],
        [".", "ch:."],
        ["return", "send"],
      ],
      "letter wide",
    );
    row(
      150,
      220,
      165,
      15,
      [
        ["new", "say:make a new note"],
        ["open", "say:open the last card"],
        ["save", "say:keep that card"],
        ["copy", "copy"],
        ["paste", "paste"],
        ["stack", "say:tidy the board"],
        ["clear", "key:clear"],
      ],
      "cmd",
    );
    row(
      90,
      150,
      165,
      15,
      [
        ["control", "key:view:control"],
        ["desk", "key:view:desk"],
        ["body", "key:view:body"],
        ["brief", "say:give me the day in brief"],
        ["inbox", "say:what's new in my inbox"],
      ],
      "cmd view",
    );
    // the KIK key: a disc at the centre
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "hk-key hk-kik");
    g.dataset.act = "key:talk";
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("r", "78");
    c.setAttribute("cy", "-6");
    const t = document.createElementNS(NS, "text");
    t.setAttribute("y", "4");
    t.textContent = "KIK";
    g.append(c, t);
    svg.append(g);
  }

  function setLine(s) {
    line = s;
    lineEl.textContent = line;
  }
  async function act(a) {
    navigator.vibrate?.(8);
    if (a.startsWith("ch:")) {
      setLine(line + a.slice(3));
      if (shift) {
        shift = false;
        draw();
      }
    } else if (a === "back") setLine(line.slice(0, -1));
    else if (a === "shift") {
      shift = !shift;
      draw();
    } else if (a === "send") {
      const text = line.trim();
      if (!text) return;
      setLine("");
      status((await post("/say", { text })) ? "sent" : "not sent");
    } else if (a === "copy") {
      await navigator.clipboard?.writeText(line).catch(() => {});
      status("copied");
    } else if (a === "paste") {
      const t = await navigator.clipboard?.readText().catch(() => "");
      if (t) setLine(line + t);
    } else if (a.startsWith("say:"))
      status((await post("/say", { text: a.slice(4) })) ? "asked" : "not sent");
    else if (a.startsWith("key:"))
      status((await post("/keys", { action: a.slice(4) })) ? "done" : "not allowed");
  }
  function status(s) {
    statusEl.textContent = s;
  }

  svg.addEventListener("pointerdown", (e) => {
    const k = e.target.closest(".hk-key");
    if (!k) return;
    k.classList.add("down");
    setTimeout(() => k.classList.remove("down"), 160);
    void act(k.dataset.act);
  });
  // a real keyboard works too
  addEventListener("keydown", (e) => {
    if (e.key === "Enter") void act("send");
    else if (e.key === "Backspace") act("back");
    else if (e.key.length === 1) setLine(line + e.key);
  });

  // Kik's last spoken line, from the stream
  try {
    const src = new EventSource(`/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    src.onopen = () => status("connected");
    src.onerror = () => status("reconnecting…");
    src.onmessage = (e) => {
      try {
        const f = JSON.parse(e.data);
        if (f.type === "speech" && f.phase === "speaking" && f.text) saidEl.textContent = f.text;
      } catch {
        /* not a frame */
      }
    };
  } catch {
    status("no stream");
  }
  draw();
})();
