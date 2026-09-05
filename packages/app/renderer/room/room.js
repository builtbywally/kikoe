// The Room. The daemon sends what happened; this decides what is shown,
// following the narrator's rule: the quiet state by default, and only rise
// above it for something a person would look up for.

const $ = (id) => document.getElementById(id);
const el = {
  body: document.body,
  history: $("history"),
  lineRepo: $("line-repo"),
  lineText: $("line-text"),
  lineHint: $("line-hint"),
  orb: $("orb"),
  orbLabel: $("orb-label"),
  board: $("board"),
  agents: $("agents"),
  cornerLeft: $("corner-left"),
  control: $("control"),
  lanes: $("lanes"),
  said: $("said"),
};

let sessions = {};
let pins = [];
let asking = null;
let pendingPermission = null;
let mode = "normal";
let speaking = false;
let history = [];
let lastLine = null;
let idleTimer = null;

// --- the spoken line ----------------------------------------------------------

function setLine(text, { repo = "", hint = [], ask = false } = {}) {
  clearTimeout(idleTimer);
  el.body.dataset.idle = "false";
  el.lineRepo.textContent = repo ? `In ${repo}` : "";
  el.lineText.textContent = "";
  // "Shall I?" and friends land in ember, the way the canvas drew them.
  const m = /^(.*?)(\s*(?:Shall I\?|Apply it\?|Yes or no\?)\s*)$/i.exec(text);
  if (ask && m) {
    el.lineText.append(m[1]);
    const em = document.createElement("em");
    em.textContent = ` ${m[2].trim()}`;
    el.lineText.append(em);
  } else el.lineText.textContent = text;
  el.lineHint.textContent = "";
  for (const h of hint) {
    const s = document.createElement("span");
    const parts = h.split("*");
    parts.forEach((p, i) => {
      if (i % 2) {
        const b = document.createElement("b");
        b.textContent = p;
        s.append(b);
      } else s.append(p);
    });
    el.lineHint.append(s);
  }
  if (lastLine && lastLine !== text) pushHistory(lastLine);
  lastLine = text;
  if (!ask) idleTimer = setTimeout(rest, 45000);
}

function pushHistory(text) {
  history.push(text);
  history = history.slice(-2);
  el.history.textContent = "";
  for (const t of history) {
    const d = document.createElement("div");
    d.textContent = t;
    el.history.append(d);
  }
}

function rest() {
  if (pendingPermission) return showPermission();
  if (asking) return showAsking();
  el.body.dataset.idle = "true";
  const rows = Object.values(sessions);
  const busy = rows.filter((s) => s.status === "working");
  el.lineRepo.textContent = "";
  el.lineHint.textContent = "";
  if (busy.length) {
    el.lineText.textContent =
      busy.length === 1 ? `${busy[0].label} is working.` : `${busy.length} agents are working.`;
  } else if (rows.length) {
    el.lineText.textContent = "All quiet.";
  } else {
    el.lineText.textContent = "Nothing to say yet.";
  }
  setOrb(speaking ? "speaking" : "idle", speaking ? "speaking" : "quiet");
}

function showPermission() {
  const p = pendingPermission;
  setLine(p.text || "It needs permission to continue. Shall I?", {
    repo: p.repo,
    hint: ["say *yes* to allow", "say *no*", "silence denies"],
    ask: true,
  });
  setOrb("asking", "waiting for your answer");
}

function showAsking() {
  const pin = pins.find((p) => p.id === asking);
  if (!pin) return;
  const what =
    pin.kind === "diff"
      ? "The diff's"
      : pin.kind === "image"
        ? "The picture's"
        : `${pin.title || "Something"} is`;
  setLine(`${what} on the board. ${pin.ask[0] ? `${cap(pin.ask[0])} it?` : ""}`.trim(), {
    repo: pin.repo,
    hint: [...pin.ask.map((a) => `say *${a}*`), "say *clear the board*"],
    ask: true,
  });
  setOrb("asking", "waiting for your answer");
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- the orb ------------------------------------------------------------------

function setOrb(state, label) {
  el.orb.className = `orb ${state}`;
  el.orbLabel.textContent = label;
  el.body.dataset.orb = state;
}

// --- the agents ---------------------------------------------------------------

function ago(s) {
  if (!s) return "";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function renderAgents() {
  el.agents.textContent = "";
  const rows = Object.values(sessions);
  const rank = (s) =>
    s.status === "waiting" ? 0 : s.status === "working" ? 1 : s.status === "failed" ? 2 : 3;
  for (const s of rows.sort((a, b) => rank(a) - rank(b))) {
    const d = document.createElement("div");
    d.className = "agent";
    d.dataset.status = s.status;
    const dot = document.createElement("span");
    dot.className = "dot";
    const name = document.createElement("span");
    name.textContent = s.label;
    const small = document.createElement("small");
    small.textContent =
      s.status === "waiting"
        ? "waiting on you"
        : s.status === "working"
          ? `${s.current_tool ? s.current_tool.toLowerCase() : "working"} · ${ago(s.running_for_s)}`
          : s.status === "failed"
            ? "failed"
            : `idle · ${ago(s.quiet_for_s)}`;
    d.append(dot, name, small);
    el.agents.append(d);
  }
  if (pins.length) {
    const hint = document.createElement("span");
    hint.className = "agent";
    hint.dataset.status = "hint";
    hint.textContent = `${pins.length} pin${pins.length === 1 ? "" : "s"} · drag to look around`;
    el.agents.append(hint);
  }
  el.cornerLeft.textContent = "";
  for (const t of [mode, `${rows.length} agent${rows.length === 1 ? "" : "s"}`]) {
    const s = document.createElement("span");
    s.textContent = t;
    el.cornerLeft.append(s);
  }
}

// --- the board ----------------------------------------------------------------

function renderDiff(body) {
  const pre = document.createElement("pre");
  for (const raw of body.split(/\r?\n/)) {
    // The patch header is for git, not for a person across the room.
    if (/^(\+\+\+|---|diff |index |@@)/.test(raw)) continue;
    const line = document.createElement("span");
    if (raw.startsWith("+")) line.className = "add";
    else if (raw.startsWith("-")) line.className = "del";
    else line.className = "ctx";
    line.textContent = raw;
    pre.append(line, "\n");
  }
  return pre;
}

function inline(text, into) {
  // `code` only; everything else is text. No HTML from the agent is trusted.
  const parts = text.split(/(`[^`]+`)/);
  for (const p of parts) {
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
      const c = document.createElement("code");
      c.textContent = p.slice(1, -1);
      into.append(c);
    } else into.append(p);
  }
}

function renderMarkdown(body) {
  const root = document.createElement("div");
  const lines = body.split(/\r?\n/);
  let list = null;
  let fence = null;
  for (const raw of lines) {
    if (raw.startsWith("```")) {
      if (fence) {
        root.append(fence);
        fence = null;
      } else fence = document.createElement("pre");
      continue;
    }
    if (fence) {
      fence.append(`${raw}\n`);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (h) {
      list = null;
      const e = document.createElement(`h${h[1].length}`);
      inline(h[2], e);
      root.append(e);
      continue;
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (li) {
      if (!list) {
        list = document.createElement("ul");
        root.append(list);
      }
      const e = document.createElement("li");
      inline(li[1], e);
      list.append(e);
      continue;
    }
    list = null;
    if (!raw.trim()) continue;
    const p = document.createElement("p");
    inline(raw, p);
    root.append(p);
  }
  if (fence) root.append(fence);
  return root;
}

function renderTable(body) {
  const table = document.createElement("table");
  const rows = body.split(/\r?\n/).filter((r) => r.trim());
  rows.forEach((r, i) => {
    const cells = r
      .split(/\s*[|\t]\s*/)
      .filter((c, j, a) => !(c === "" && (j === 0 || j === a.length - 1)));
    if (cells.every((c) => /^:?-+:?$/.test(c))) return;
    const tr = document.createElement("tr");
    for (const c of cells) {
      const td = document.createElement(i === 0 ? "th" : "td");
      td.textContent = c;
      tr.append(td);
    }
    table.append(tr);
  });
  return table;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function sanitizeSvg(markup) {
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) {
    const pre = document.createElement("pre");
    pre.textContent = "not an SVG";
    return pre;
  }
  for (const el of [...root.querySelectorAll("*"), root]) {
    const name = el.nodeName.toLowerCase();
    if (
      [
        "script",
        "foreignobject",
        "iframe",
        "object",
        "embed",
        "audio",
        "video",
        "animate",
        "set",
      ].includes(name)
    ) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      const v = attr.value.trim().toLowerCase();
      if (n.startsWith("on")) el.removeAttribute(attr.name);
      else if (
        (n === "href" || n === "xlink:href") &&
        !(v.startsWith("#") || v.startsWith("data:image/"))
      )
        el.removeAttribute(attr.name);
      else if (n === "style" && /url\(|expression|javascript:/i.test(v))
        el.removeAttribute(attr.name);
    }
  }
  const out = document.importNode(root, true);
  if (!out.getAttribute("viewBox") && out.getAttribute("width") && out.getAttribute("height")) {
    out.setAttribute(
      "viewBox",
      `0 0 ${Number.parseFloat(out.getAttribute("width"))} ${Number.parseFloat(out.getAttribute("height"))}`,
    );
  }
  out.removeAttribute("width");
  out.removeAttribute("height");
  out.setAttribute("class", "vector");
  return out;
}

function renderBody(pin) {
  switch (pin.kind) {
    case "diff":
      return renderDiff(pin.body);
    case "markdown":
      return renderMarkdown(pin.body);
    case "table":
      return renderTable(pin.body);
    case "image": {
      const img = document.createElement("img");
      const src = pin.body.trim();
      img.src = src.startsWith("data:")
        ? src
        : `file:///${src.replace(/\\/g, "/").replace(/^\/+/, "")}`;
      img.alt = pin.title;
      return img;
    }
    case "svg": {
      // Inline, so it scales with the canvas and takes the theme's colour,
      // and sanitised, so it is a picture and not a program.
      return sanitizeSvg(pin.body);
    }
    case "html": {
      // Sandboxed: no scripts, no navigation, no same-origin. A page, not a program.
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "");
      f.srcdoc = pin.body;
      return f;
    }
    default: {
      const pre = document.createElement("pre");
      pre.textContent = pin.body;
      return pre;
    }
  }
}

function pinCard(p) {
  const now = Date.now() / 1000;
  const age = now - p.created;
  const left = p.ttl_s - age;
  const card = document.createElement("div");
  card.className = "pin";
  card.dataset.kind = p.kind;
  card.dataset.asking = String(p.ask.length > 0 && p.answer === null);
  // Fade with age: full for the first third of its life, then down to 0.35.
  const life = Math.max(0, Math.min(1, left / p.ttl_s));
  card.style.opacity = String(0.35 + 0.65 * Math.min(1, life * 1.5));
  const head = document.createElement("div");
  head.className = "pin-head";
  const title = document.createElement("span");
  title.className = "title";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "14");
  icon.setAttribute("height", "14");
  const mark = document.createElementNS("http://www.w3.org/2000/svg", "path");
  mark.setAttribute("fill", "none");
  mark.setAttribute("stroke-width", "1.8");
  mark.setAttribute("stroke-linecap", "round");
  if (p.kind === "diff") {
    mark.setAttribute("d", "M12 5v14M5 12h14");
    mark.setAttribute("stroke", "#d2683f");
  } else {
    mark.setAttribute("d", "M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7");
    mark.setAttribute("stroke", "#8b8b80");
  }
  icon.append(mark);
  const t = document.createElement("span");
  t.textContent = p.title || p.kind;
  title.append(icon, t);
  const when = document.createElement("span");
  when.className = "age";
  when.textContent =
    p.ask.length && p.answer === null
      ? `pinned now · ${ago(Math.max(1, Math.round((p.wait_s || left) - age)))}`
      : p.answer
        ? `answered: ${p.answer}`
        : age < 60
          ? "pinned now"
          : `${ago(Math.round(age))} · fades in ${ago(Math.round(left))}`;
  head.append(title, when);
  const body = document.createElement("div");
  body.className = "pin-body";
  body.append(renderBody(p));
  card.append(head, body);
  const foot = document.createElement("div");
  foot.className = "pin-foot";
  if (p.ask.length && p.answer === null) {
    p.ask.forEach((a, i) => {
      const b = document.createElement("button");
      b.textContent = `say “${a}”`;
      if (i === 0) b.className = "primary";
      b.addEventListener("click", () => window.room.answerPin(p.id, a));
      foot.append(b);
    });
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = "nothing here is editable";
    foot.append(note);
  } else {
    const x = document.createElement("button");
    x.textContent = "dismiss";
    x.addEventListener("click", () => window.room.removePin(p.id));
    foot.append(x);
  }
  card.append(foot);
  return card;
}

function renderBoard() {
  el.body.dataset.hasPins = pins.length ? "true" : "false";
  window.board.render(pins, pinCard);
}

// --- the control room -------------------------------------------------------------

function empty(host, text) {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = text;
  host.append(d);
}

function renderNeeds(state) {
  const needs = $("needs");
  const q = $("needs-q");
  const k = $("needs-k");
  const a = $("needs-a");
  a.textContent = "";
  q.textContent = "";
  const perm = state?.pending_permission;
  const pin = (state?.pins ?? []).find((p) => p.id === state?.asking);
  if (!perm && !pin) {
    needs.hidden = true;
    return;
  }
  needs.hidden = false;
  if (perm) {
    k.textContent = `needs you · ${perm.repo || "an agent"}`;
    q.textContent = perm.text
      ? `It wants to run ${perm.text}. `
      : "It needs permission to continue. ";
    const em = document.createElement("em");
    em.textContent = "Shall I?";
    q.append(em);
    for (const [word, cls] of [
      ["yes", "primary"],
      ["no", ""],
    ]) {
      const b = document.createElement("button");
      b.className = cls;
      b.textContent = `say “${word}”`;
      b.addEventListener("click", () => window.room.answerWord(word));
      a.append(b);
    }
    return;
  }
  k.textContent = `needs you · ${pin.repo || "the board"}`;
  q.textContent = `${pin.title || "Something"} is on the board. `;
  const em = document.createElement("em");
  em.textContent = pin.ask[0] ? `${cap(pin.ask[0])} it?` : "";
  q.append(em);
  pin.ask.forEach((word, i) => {
    const b = document.createElement("button");
    b.className = i === 0 ? "primary" : "";
    b.textContent = `say “${word}”`;
    b.addEventListener("click", () => window.room.answerPin(pin.id, word));
    a.append(b);
  });
}

function renderControl(state) {
  renderNeeds(state);
  el.lanes.textContent = "";
  const rows = Object.values(sessions);
  if (!rows.length)
    empty(el.lanes, "No agents yet. Give Claude Code a task and its session appears here.");
  const rank = (s) => (s.status === "waiting" ? 0 : s.status === "working" ? 1 : 2);
  for (const s of rows.sort((a, b) => rank(a) - rank(b))) {
    const lane = document.createElement("div");
    lane.className = "lane";
    lane.dataset.status = s.status;
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = s.label;
    const st = document.createElement("span");
    st.textContent = s.status;
    name.append(st);
    const facts = document.createElement("div");
    facts.className = "facts";
    const fact = (t, strong) => {
      const d = document.createElement("span");
      if (strong) {
        d.append(`${t.split(":")[0]}: `);
        const b = document.createElement("b");
        b.textContent = t.split(":").slice(1).join(":").trim();
        d.append(b);
      } else d.textContent = t;
      facts.append(d);
    };
    if (s.status === "working" && s.current_tool)
      fact(`${s.current_tool.toLowerCase()} · ${ago(s.running_for_s)}`);
    if (s.status === "waiting" && s.pending_permission)
      fact(`waiting: ${s.pending_permission}`, true);
    fact(`turn ${s.turns} · quiet ${ago(s.quiet_for_s)}`);
    if (s.last_test_result) fact(`tests: ${s.last_test_result}`, true);
    if (s.last_error) fact(`error: ${s.last_error.slice(0, 80)}`);
    if (s.files_touched?.length)
      fact(
        `touched ${s.files_touched
          .map((f) => f.split(/[\\/]/).pop())
          .slice(-3)
          .join(", ")}`,
      );
    const last = document.createElement("div");
    last.className = "last";
    const said = (state?.history ?? []).find((h) => h.label === s.label);
    last.textContent = said ? `“${said.text}”` : "nothing said yet";
    lane.append(name, facts, last);
    el.lanes.append(lane);
  }
  const you = $("you-said");
  you.textContent = "";
  if (!(state?.heard ?? []).length)
    empty(
      you,
      state?.mic?.enabled
        ? "Nothing heard yet. Say “hey kikoe”."
        : "The microphone is off. Turn it on under General.",
    );
  for (const h of state?.heard ?? []) {
    const d = document.createElement("div");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = new Date(h.ts * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const m = document.createElement("span");
    m.textContent = `“${h.text}”`;
    const k = document.createElement("span");
    k.className = "k";
    k.dataset.kind = h.kind;
    k.textContent = ` · ${h.kind}${h.said ? ` → ${h.said.slice(0, 60)}` : ""}${h.stt_ms !== null ? ` · ${h.stt_ms} ms` : ""}`;
    m.append(k);
    d.append(t, m);
    you.append(d);
  }
  el.said.textContent = "";
  if (!(state?.history ?? []).length) empty(el.said, "Nothing said yet.");
  for (const h of state?.history ?? []) {
    const d = document.createElement("div");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = new Date(h.ts * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const m = document.createElement("span");
    m.textContent = h.text;
    const meta = document.createElement("span");
    meta.className = "m";
    meta.textContent = ` · ${h.backend}${h.latency_ms !== null ? ` · ${h.latency_ms} ms` : ""}`;
    m.append(meta);
    d.append(t, m);
    el.said.append(d);
  }
}

async function showControl() {
  const state = await window.room.state();
  sessions = state?.sessions ?? sessions;
  renderControl(state);
  el.control.hidden = false;
  el.body.dataset.view = "control";
}

function showRoom() {
  el.control.hidden = true;
  el.body.dataset.view = "room";
}

// --- frames --------------------------------------------------------------------

const handlers = {
  hello(f) {
    sessions = f.sessions ?? {};
    mode = f.mode ?? mode;
    renderAgents();
    rest();
    window.room.state().then((s) => {
      if (!s) return;
      pins = s.pins ?? [];
      asking = s.asking ?? null;
      pendingPermission = s.pending_permission ? { ...s.pending_permission, text: "" } : null;
      for (const h of [...(s.history ?? [])].reverse().slice(-2)) pushHistory(h.text);
      renderBoard();
      renderAgents();
      rest();
    });
  },
  sessions(f) {
    sessions = f.sessions ?? {};
    renderAgents();
    if (el.body.dataset.view === "control") showControl();
    if (el.body.dataset.idle === "true") rest();
  },
  mode(f) {
    mode = f.mode ?? mode;
    renderAgents();
  },
  event(f) {
    if (f.kind === "permission") {
      const args = f.args ?? {};
      pendingPermission = {
        repo: f.repo,
        session: f.session,
        text: f.text || (args.command ? `It wants to run ${args.command}. Shall I?` : ""),
        id: f.id,
      };
      return;
    }
    if (
      pendingPermission &&
      (f.kind === "tool_end" || f.kind === "turn_end") &&
      (!f.session || f.session === pendingPermission.session)
    ) {
      pendingPermission = null;
      if (!speaking) rest();
    }
  },
  permission() {
    pendingPermission = null;
    if (!speaking) rest();
    if (el.body.dataset.view === "control") showControl();
  },
  spoken() {
    if (el.body.dataset.view === "control") showControl();
  },
  speech(f) {
    if (f.phase === "speaking") {
      speaking = true;
      const isAsk = /shall i\?|apply it\?$/i.test(f.text ?? "");
      const repo = /^In ([\w.-]+), /.exec(f.text ?? "")?.[1] ?? "";
      const text = repo
        ? (f.text ?? "").replace(/^In [\w.-]+, /, (m) => "").replace(/^\w/, (c) => c.toUpperCase())
        : (f.text ?? "");
      setLine(text, { repo, ask: isAsk, hint: isAsk ? ["say *yes*", "say *no*"] : [] });
      setOrb("speaking", "speaking");
      return;
    }
    speaking = false;
    if (pendingPermission) return showPermission();
    if (asking) return showAsking();
    setOrb("idle", "quiet");
  },
  mic(f) {
    if (f.phase === "hearing") return setOrb("listening", "hearing you");
    if (f.phase === "transcribing") return setOrb("listening", "one moment");
    if (f.phase === "addressed") {
      setOrb("listening", "heard you");
      el.lineRepo.textContent = "you said";
      el.lineText.textContent = `“${f.text}”`;
      el.lineHint.textContent = "";
      return;
    }
    if (f.phase === "overheard") return setOrb("idle", "not for me");
    if (f.phase === "thinking") return setOrb("speaking", "thinking");
    if (f.phase === "idle" && !speaking) {
      if (pendingPermission) return showPermission();
      if (asking) return showAsking();
      setOrb("idle", "listening");
    }
  },
  view(f) {
    if (f.view === "control") showControl();
    else showRoom();
  },
  heard() {
    if (el.body.dataset.view === "control") showControl();
  },
  pin(f) {
    if (f.op === "add" && f.pin) {
      pins = [...pins.filter((p) => p.id !== f.pin.id), f.pin];
      if (f.pin.ask.length) asking = f.pin.id;
    } else if (f.op === "answer" && f.pin) {
      pins = pins.map((p) => (p.id === f.pin.id ? f.pin : p));
      if (asking === f.pin.id) asking = null;
    } else if (f.op === "remove") {
      pins = pins.filter((p) => p.id !== f.id);
      if (asking === f.id) asking = null;
    } else if (f.op === "clear") {
      pins = [];
      asking = null;
    }
    renderBoard();
    renderAgents();
    if (asking) showAsking();
    else if (!speaking && !pendingPermission) rest();
  },
};

setInterval(() => {
  if (pins.length) renderBoard();
}, 15000);

// --- controls ----------------------------------------------------------------------

$("btn-board").addEventListener("click", showControl);
$("btn-room").addEventListener("click", showRoom);
$("btn-clear").addEventListener("click", () => window.room.clearBoard());
$("btn-settings").addEventListener("click", () => window.settingsPanel.open());
if (window.room.onView)
  window.room.onView((v) => {
    if (v.view === "settings") window.settingsPanel.open(v.page);
    else if (v.view === "control") showControl();
    else {
      window.settingsPanel.close();
      showRoom();
    }
  });
document.addEventListener("keydown", (e) => {
  if (e.target && ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  if (e.key === "c" || e.key === "C")
    el.body.dataset.view === "control" ? showRoom() : showControl();
  if (e.key === "Escape") {
    if (el.body.dataset.view === "settings") window.settingsPanel.close();
    else showRoom();
  }
  if (e.key === "y" || e.key === "Y") window.room.answerWord("yes");
  if (e.key === "n" || e.key === "N") window.room.answerWord("no");
});

// An idle Room costs nothing: animations stop when the window is hidden.
document.addEventListener("visibilitychange", () => {
  document.body.classList.toggle("paused", document.hidden);
});

window.room.stream(
  (frame) => {
    const fn = handlers[frame.type];
    if (fn) fn(frame);
  },
  (status) => {
    document.body.classList.toggle("disconnected", status === "disconnected");
    if (status === "disconnected") {
      el.lineText.textContent = "Kikoe isn't running.";
      setOrb("idle", "no daemon");
    }
  },
);
