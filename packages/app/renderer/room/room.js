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
// the last snapshot from the daemon: the conversation card reads heard from it
let state = null;
// what Kik suggested you say next; a live line of what you are saying; recent events per repo
let suggestions = [];
let liveYou = "";
let thinking = false;
const recentEvents = new Map();
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

let micWatchdog = null;
let overheardUntil = 0;
let attendingUntil = 0;
let attendingTimer = null;
/** The backdrop: bundled by name and theme, or the user's own image. */
function applyLook(look) {
  if (!look) return;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const board = document.getElementById("board");
  board.dataset.backdrop = look.backdrop || "grid";
  let url = "";
  if (["paper", "ink", "aurora", "nebula"].includes(look.backdrop))
    url = `url(../backdrops/${look.backdrop}-${dark ? "dark" : "light"}.jpg)`;
  else if (look.backdrop === "custom" && look.image)
    url = window.room.native
      ? `url(file:///${String(look.image).replace(/\\/g, "/")})`
      : `url(${window.room.backdropUrl ? window.room.backdropUrl() : ""})`;
  board.style.setProperty("--backdrop-url", url || "none");
  board.style.setProperty("--backdrop-dim", String(look.dim ?? 0.35));
  document.body.dataset.frosted = look.blur === false ? "0" : "1";
}
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => applyLook(state?.look));

// The dotted thought-orb (Thinking Orbs): what Kik is doing, as one of its
// nine verbs. The big orb, the talking card's orb and the phone's all follow
// this one function, so they never disagree.
const bigOrb = window.KikOrb?.create(document.getElementById("orb-dots"), { size: 64 });
let kikVerb = "breathing";
function setOrb(state, label) {
  el.orb.className = `orb ${state}`;
  el.orbLabel.textContent = label;
  el.body.dataset.orb = state;
  // "speaking" with the label "thinking" is the model working, not talking
  kikVerb = window.KikOrb?.forKik(label === "thinking" ? "thinking" : state) ?? "breathing";
  bigOrb?.set(kikVerb);
  cardOrbs.conversation?.set(kikVerb);
  window.dispatchEvent(new CustomEvent("kik-orb", { detail: kikVerb }));
}

/** The small orbs in the headers of Kik's and the agent's cards, by card kind. */
const cardOrbs = {};
/** A 20-pixel orb for a card's header, standing in for its plain icon. */
function cardOrb(kind) {
  if (!window.KikOrb) return null;
  const c = document.createElement("canvas");
  c.className = "card-orb";
  const verb =
    kind === "conversation"
      ? kikVerb
      : kind === "thinking"
        ? (state?.thinking ?? []).some((t) => t.status === "thinking")
          ? "solving"
          : "breathing"
        : Object.values(sessions).some((s) => s.status === "working")
          ? "working"
          : Object.values(sessions).some((s) => s.status === "waiting")
            ? "connecting"
            : "breathing";
  cardOrbs[kind] = window.KikOrb.create(c, { size: 20, state: verb });
  return c;
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
  renderProject(rows.length);
}

/**
 * Which board you are on, in the corner beside the mode.
 *
 * With thirteen projects the answer to "why is my canvas empty" has to be
 * visible without asking, and saying the name is how you get back.
 */
function renderProject(agents) {
  const n = agents ?? Object.keys(state?.sessions ?? {}).length;
  const name = state?.project?.name || "";
  el.cornerLeft.textContent = "";
  for (const t of [name, mode, `${n} agent${n === 1 ? "" : "s"}`]) {
    if (!t) continue;
    const s = document.createElement("span");
    s.textContent = t;
    if (t === name) s.className = "project";
    el.cornerLeft.append(s);
  }
}

// --- the board ----------------------------------------------------------------

function renderDiff(body) {
  const pre = document.createElement("pre");
  for (const raw of body.split(/\r?\n/)) {
    // The file header is for git, not for a person across the room.
    if (/^(\+\+\+|---|diff |index )/.test(raw)) continue;
    // A hunk header is different: without it you cannot tell a change at
    // line 20 from the same change at line 900, and that is usually the
    // whole question. Shown as a rule with the line number, not as `@@`.
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      const rule = document.createElement("span");
      rule.className = "hunk";
      rule.textContent = `line ${hunk[1]}`;
      pre.append(rule, "\n");
      continue;
    }
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

// A command and what it printed. The command reads as a command — ember, with
// its prompt — and stderr is set apart, because a failing run is the one you
// are looking at and its useful half has never been shown before now.
function renderRun(body) {
  const pre = document.createElement("pre");
  let stream = "out";
  for (const raw of body.split(/\r?\n/)) {
    const line = document.createElement("span");
    if (raw.startsWith("$ ")) line.className = "cmd";
    else if (raw === "--- stderr ---") {
      stream = "err";
      line.className = "hunk";
      line.textContent = "stderr";
      pre.append(line, "\n");
      continue;
    } else line.className = stream === "err" ? "del" : "ctx";
    line.textContent = raw;
    pre.append(line, "\n");
  }
  return pre;
}

function renderBody(pin) {
  switch (pin.kind) {
    case "diff":
      return renderDiff(pin.body);
    case "run":
    case "result":
      return renderRun(pin.body);
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
    case "web": {
      // A live page: an app on localhost, a site, a browser. Its own origin,
      // its own scripts; it can never reach the Room.
      const f = document.createElement("iframe");
      f.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-forms allow-popups allow-presentation",
      );
      // a video player on the canvas plays, and can go full screen
      f.setAttribute(
        "allow",
        "clipboard-read; clipboard-write; autoplay; encrypted-media; fullscreen; picture-in-picture",
      );
      f.setAttribute("allowfullscreen", "");
      f.src = pin.body.trim();
      f.title = pin.title || pin.body;
      // On a phone a site may refuse to be shown inside the canvas (the desk
      // app lifts that; a phone's browser cannot), and a viewer has no card
      // footer: so the card carries its own way out.
      if (document.documentElement.dataset.phone === "true") {
        const wrap = document.createElement("div");
        wrap.className = "web-wrap";
        const out = document.createElement("a");
        out.className = "web-out";
        out.href = pin.body.trim();
        out.target = "_blank";
        out.rel = "noopener";
        out.textContent = "open ↗";
        wrap.append(f, out);
        return wrap;
      }
      return f;
    }
    case "react":
    case "html": {
      // A page Kik made, served by the daemon with the runtime it needs
      // (React, Tailwind, icons, charts from the allowlist). Its own
      // origin; it can never reach the Room.
      const f = document.createElement("iframe");
      const base = window.room.artifactBase;
      if (base) {
        f.setAttribute(
          "sandbox",
          "allow-scripts allow-same-origin allow-forms allow-popups allow-modals",
        );
        f.src = `${base}/artifact/${encodeURIComponent(pin.id)}?v=${pin.updated}`;
      } else {
        f.setAttribute("sandbox", "allow-scripts");
        f.srcdoc = pin.body;
      }
      f.title = pin.title || pin.kind;
      return f;
    }
    default: {
      const pre = document.createElement("pre");
      pre.textContent = pin.body;
      return pre;
    }
  }
}

/** device viewports for a page or a site on the canvas: name, width, height */
const VIEWPORTS = [
  ["phone", 390, 700],
  ["tablet", 820, 700],
  ["desktop", 1280, 760],
];
/** the card's head and foot around the frame */
const CARD_CHROME = 106;

/**
 * What time changes on a card, and nothing else: how faded it is and its age
 * line. The board asks for this on every tick instead of building the whole
 * card again only to read these two things off it.
 */
function pinFresh(p) {
  const now = Date.now() / 1000;
  const age = now - p.created;
  const left = p.ttl_s - age;
  // Fade with age: full for the first third of its life, then down to 0.35.
  const life = p.sticky ? 1 : Math.max(0, Math.min(1, left / p.ttl_s));
  const opacity = String(0.35 + 0.65 * Math.min(1, life * 1.5));
  const text =
    p.ask.length && p.answer === null
      ? `pinned now · ${ago(Math.max(1, Math.round((p.wait_s || left) - age)))}`
      : p.answer
        ? `answered: ${p.answer}`
        : p.kind === "conversation"
          ? thinking
            ? "thinking"
            : "with you"
          : p.kind === "thinking"
            ? (state?.thinking ?? []).some((t) => t.status === "thinking")
              ? "thinking"
              : "idle"
            : p.kind === "agents" || p.kind === "events" || p.kind === "session"
              ? "live"
              : p.sticky
                ? `${p.by === "kik" ? "kik" : p.by === "you" ? "you" : "agent"} · kept`
                : age < 60
                  ? "pinned now"
                  : `${ago(Math.round(age))} · fades in ${ago(Math.round(left))}`;
  return { opacity, age: text };
}

function pinCard(p) {
  const card = document.createElement("div");
  card.className = "pin";
  card.dataset.kind = p.kind;
  card.dataset.id = p.id;
  card.dataset.asking = String(p.ask.length > 0 && p.answer === null);
  const fresh = pinFresh(p);
  card.style.opacity = fresh.opacity;
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
  // Kik's two sessions and the agent wear a thought-orb for what they are doing
  const live =
    p.kind === "conversation" || p.kind === "thinking" || p.kind === "session"
      ? cardOrb(p.kind)
      : null;
  title.append(live ?? icon, t);
  const when = document.createElement("span");
  when.className = "age";
  when.textContent = fresh.age;
  head.append(title, when);
  const body = document.createElement("div");
  body.className = "pin-body";
  if (p.kind === "conversation") body.append(conversationBody());
  else if (p.kind === "session") body.append(sessionBody());
  else if (p.kind === "thinking") body.append(thinkingBody());
  else if (p.kind === "agents") body.append(agentsBody());
  else if (p.kind === "events") body.append(eventsBody(p.repo));
  else if (p.kind === "checklist") body.append(checklistBody(p));
  else if (p.kind === "note") body.append(noteBody(p));
  else body.append(renderBody(p));
  card.append(head, body);
  card.dataset.by = p.by ?? "agent";
  if (p.sticky) card.dataset.sticky = "1";
  const foot = document.createElement("div");
  foot.className = "pin-foot";
  if (
    p.kind === "conversation" ||
    p.kind === "session" ||
    p.kind === "thinking" ||
    p.kind === "agents" ||
    p.kind === "events"
  ) {
    card.dataset.live = "1";
    if (p.kind === "conversation" && speaking) card.dataset.speaking = "1";
    card.append(foot);
    return card;
  }
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
    if (p.kind === "web" || p.kind === "html" || p.kind === "react") {
      // a viewport to look at the page in: the card takes the device's size
      const views = document.createElement("span");
      views.className = "viewports";
      for (const [name, w, h] of VIEWPORTS) {
        const b = document.createElement("button");
        b.textContent = name;
        b.title = `${w} × ${h}`;
        b.className = "viewport";
        if (p.w === w + 2) b.classList.add("active");
        b.addEventListener("click", () =>
          window.room.updatePin?.(p.id, { w: w + 2, h: h + CARD_CHROME, wide: true }),
        );
        views.append(b);
      }
      foot.append(views);
    }
    // A work card can be acted on, not only read. Every one of these goes to
    // the agent as an instruction — Kikoe writes no source file and runs no
    // build of its own, so a revert is an edit you can see and judge.
    if (p.stream === "work") {
      const act = (label, action, title) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", async () => {
          b.disabled = true;
          const was = b.textContent;
          b.textContent = "…";
          const r = await window.room.actOnPin?.(p.id, action);
          b.textContent = r?.ok ? "sent" : was;
          setTimeout(() => {
            b.textContent = was;
            b.disabled = false;
          }, 2000);
        });
        foot.append(b);
      };
      if (p.kind === "run" || p.kind === "result")
        act("run again", "again", "ask the agent to re-run it");
      if (p.kind === "diff") act("revert", "revert", "ask the agent to put this file back");
      if (p.kind === "diff" || p.kind === "run" || p.kind === "result")
        act("explain", "explain", "ask the agent what this did");
    }
    if (p.kind === "web") {
      const addr = document.createElement("span");
      addr.className = "note";
      addr.textContent = p.body
        .trim()
        .replace(/^https?:\/\//, "")
        .slice(0, 60);
      const open = document.createElement("button");
      open.textContent = "open";
      open.title = "in your browser";
      open.addEventListener("click", () => window.room.openArtifact(p.id));
      foot.append(addr, open);
    } else if (
      p.kind === "html" ||
      p.kind === "react" ||
      p.kind === "svg" ||
      p.kind === "image" ||
      p.size === "wide"
    ) {
      const open = document.createElement("button");
      open.textContent = "open";
      open.title = "in its own window";
      open.addEventListener("click", () => window.room.openArtifact(p.id));
      const save = document.createElement("button");
      save.textContent = "download";
      save.addEventListener("click", () => window.room.saveArtifact(p.id));
      foot.append(open, save);
    }
    const ask = document.createElement("button");
    ask.textContent = "ask kik";
    ask.addEventListener("click", () => {
      const q = window.prompt(`Ask Kik about “${p.title || p.kind}”`);
      if (q?.trim())
        window.room.sayToKik(
          `About the ${p.kind} "${p.title}" on the canvas (id ${p.id}): ${q.trim()}`,
        );
    });
    const keep = document.createElement("button");
    keep.textContent = p.sticky ? "unpin" : "keep";
    keep.title = p.sticky ? "let it fade" : "keep it until removed";
    keep.addEventListener("click", () => window.room.updatePin(p.id, { sticky: !p.sticky }));
    const x = document.createElement("button");
    x.textContent = "dismiss";
    x.addEventListener("click", () => window.room.removePin(p.id));
    foot.append(ask, keep, x);
  }
  card.append(foot);
  return card;
}

function renderBoard() {
  // The canvas is always there: it is how Kik talks to you.
  el.body.dataset.hasPins = "true";
  const talk = {
    id: "conversation",
    kind: "conversation",
    title: "kik · talking",
    body: "",
    repo: "kik",
    by: "kik",
    created: Date.now() / 1000,
    updated: Date.now() / 1000,
    ttl_s: 1e9,
    sticky: true,
    ask: [],
    answer: null,
    wait_s: 0,
  };
  const ordered = [...pins].sort(
    (a, b) => (a.repo === "kik" ? -1 : 0) - (b.repo === "kik" ? -1 : 0),
  );
  const extra = [];
  // Kik's thinking session: shown once it has been asked something, beside
  // the talking one, so it is plain which of the two is doing what.
  if (state?.thinking?.length)
    extra.push({
      ...talk,
      id: "thinking",
      kind: "thinking",
      title: "kik · thinking",
      sticky: true,
    });
  if (Object.keys(sessions).length)
    extra.push({ ...talk, id: "agents", kind: "agents", title: "agents", sticky: true });
  // The thread: the one place that says what has been happening, in order.
  extra.push({
    ...talk,
    id: "session",
    kind: "session",
    // the coding agent's thread, not Kik: named so, since "the session" read
    // as a second Kik once Kik had two sessions of its own
    title: state?.project?.name ? `agent · ${state.project.name}` : "agent",
    sticky: true,
  });
  for (const [repo, events] of recentEvents)
    if (events.length)
      extra.push({
        ...talk,
        id: `events:${repo}`,
        kind: "events",
        title: "what happened",
        repo,
        sticky: true,
      });
  window.board.render([talk, ...extra, ...ordered], pinCard, pinFresh);
}

/** The one place you can type instead of talk; both threads carry it. */
function replyBox(placeholder) {
  const form = document.createElement("form");
  form.className = "chat-reply";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "send";
  form.append(input, send);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    window.room.sayToKik(text);
  });
  return form;
}

/**
 * The session: you, Kik, and the agent, in one place and in order.
 *
 * The work has been on the canvas for a while, but scattered — a diff here,
 * a test run there, and nothing saying which came after which or why. This
 * is the thread: what you asked for, what Kik said back, and every move the
 * agent made between them. It is built here rather than stored, from the
 * heard log and the work cards that already exist, so it costs no state.
 *
 * Every agent line points at its card. The thread is the index; the cards
 * are the detail.
 */
/**
 * The thinking session: each question the talking session handed over, what
 * it is doing now, and what it concluded. A thought that left detail on the
 * canvas links to its card.
 */
function thinkingBody() {
  const wrap = document.createElement("div");
  wrap.className = "thread";
  for (const t of state?.thinking ?? []) {
    const q = document.createElement("div");
    q.className = "chat-you";
    q.textContent = t.question;
    wrap.append(q);
    const a = document.createElement("div");
    a.className = t.status === "done" ? "chat-kik" : "thread-agent";
    if (t.status === "thinking") {
      const s = Math.max(1, Math.round((Date.now() - t.started) / 1000));
      a.textContent = `thinking… ${s}s`;
      a.classList.add("thinking-now");
    } else if (t.status === "failed") {
      a.textContent = `didn't finish: ${t.answer}`;
    } else {
      a.textContent = t.answer;
    }
    wrap.append(a);
    if (t.pin) {
      const link = document.createElement("div");
      link.className = "thread-agent";
      link.dataset.id = t.pin;
      link.textContent = "the detail is on the canvas →";
      link.addEventListener("click", () => window.board.focus?.(t.pin));
      wrap.append(link);
    }
  }
  return wrap;
}

function sessionBody() {
  const wrap = document.createElement("div");
  wrap.className = "thread";

  // What you said to the agent and what Kik said about it, with the time each
  // happened. Only what reached the agent: a hello or a question Kik answered
  // itself is the conversation card's, and showing it here too made two cards
  // saying the same thing (seen on the phone, where they sit one above the other).
  const toAgent = (h) =>
    h.kind === "work" ||
    ["agent", "new_session", "instruct", "work"].includes(h.intent) ||
    /^(passed it to|queued for|started an agent)/i.test(h.said || "");
  const said = [...(state?.heard ?? [])]
    .reverse()
    .filter((h) => h.text && h.kind !== "overheard" && toAgent(h))
    .map((h) => ({ at: Number(h.ts ?? 0), who: "you", text: h.text, said: h.said || "" }));

  // What the agent did, read off the work cards rather than kept twice.
  const work = pins
    .filter((p) => p.stream === "work")
    .map((p) => ({
      at: Number(p.created ?? 0),
      who: "agent",
      id: p.id,
      text:
        p.kind === "diff"
          ? `edited ${p.title}`
          : p.kind === "result"
            ? `tests: ${p.title}`
            : p.kind === "run"
              ? `ran ${p.title}`
              : p.title || "replied",
      body: p.kind === "markdown" ? p.body : "",
    }));

  const rows = [...said, ...work].sort((a, b) => a.at - b.at).slice(-14);
  if (!rows.length) {
    const e = document.createElement("div");
    e.className = "chat-empty";
    e.textContent = "Nothing yet. Say what you want done and it starts here.";
    wrap.append(e);
  }

  for (const r of rows) {
    if (r.who === "you") {
      const you = document.createElement("div");
      you.className = "chat-you";
      you.textContent = r.text;
      wrap.append(you);
      if (r.said) {
        const kik = document.createElement("div");
        kik.className = "chat-kik";
        kik.textContent = r.said;
        wrap.append(kik);
      }
      continue;
    }
    const line = document.createElement("div");
    line.className = "thread-agent";
    if (r.body) {
      // The agent's own words are worth reading, not just referring to.
      line.classList.add("says");
      line.textContent = firstLines(r.body, 3);
    } else {
      line.textContent = r.text;
    }
    if (r.id) {
      line.dataset.id = r.id;
      line.title = "show me";
      line.addEventListener("click", () => window.board.focus(r.id));
    }
    wrap.append(line);
  }

  // What it is doing right now, so the thread has a live end.
  const busy = Object.values(sessions).filter((s) => s.status === "working");
  if (busy.length) {
    const now = document.createElement("div");
    now.className = "thread-now";
    now.textContent = busy
      .map((s) => `${s.label} · ${s.current_tool ? s.current_tool.toLowerCase() : "working"}`)
      .join(" · ");
    wrap.append(now);
  }

  wrap.append(replyBox("say what you want done…"));
  return wrap;
}

/** The first few lines of something long, for a thread that stays readable. */
function firstLines(text, n) {
  const lines = String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const head = lines.slice(0, n).join(" ");
  return head.length > 260 ? `${head.slice(0, 259)}…` : head;
}

/** The agents card: each one, what it is doing, and the buttons when one waits on you. */
function agentsBody() {
  const wrap = document.createElement("div");
  wrap.className = "agents-card";
  const rank = (s) =>
    s.status === "waiting" ? 0 : s.status === "working" ? 1 : s.status === "failed" ? 2 : 3;
  for (const s of Object.values(sessions).sort((a, b) => rank(a) - rank(b))) {
    const row = document.createElement("div");
    row.className = "agent-row";
    row.dataset.status = s.status;
    const dot = document.createElement("span");
    dot.className = "dot";
    const name = document.createElement("b");
    name.textContent = s.label;
    const what = document.createElement("span");
    what.textContent =
      s.status === "waiting"
        ? s.pending_permission || "waiting on you"
        : s.status === "working"
          ? `${s.current_tool ? s.current_tool.toLowerCase() : "working"} · ${ago(s.running_for_s)}`
          : s.status === "failed"
            ? `failed${s.last_error ? `: ${s.last_error.slice(0, 80)}` : ""}`
            : `idle · ${ago(s.quiet_for_s)}`;
    row.append(dot, name, what);
    if (s.status === "waiting") {
      const yes = document.createElement("button");
      yes.className = "primary";
      yes.textContent = "approve";
      yes.addEventListener("click", () => window.room.answerWord("yes"));
      const no = document.createElement("button");
      no.textContent = "deny";
      no.addEventListener("click", () => window.room.answerWord("no"));
      row.append(yes, no);
    }
    wrap.append(row);
  }
  return wrap;
}

/** What happened in a repo lately, as the narrator saw it. */
function eventsBody(repo) {
  const wrap = document.createElement("div");
  wrap.className = "events-card";
  for (const e of recentEvents.get(repo) ?? []) {
    const row = document.createElement("div");
    row.className = "event-row";
    row.dataset.kind = e.kind;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = new Date(e.ts * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const m = document.createElement("span");
    m.textContent = e.text;
    row.append(t, m);
    wrap.append(row);
  }
  return wrap;
}

/** The conversation card: what you said, what Kik said, and a way to type to it. */
function conversationBody() {
  const wrap = document.createElement("div");
  wrap.className = "chat";
  const rows = [...(state?.heard ?? [])]
    .reverse()
    .filter((h) => h.text && h.kind !== "overheard")
    .slice(-8);
  if (!rows.length) {
    const e = document.createElement("div");
    e.className = "chat-empty";
    e.textContent = state?.brain?.on
      ? "Say “kik” and talk, or type below. Ask it to make a checklist, draw a diagram, or explain a diff."
      : "Turn on “a mind of its own” in settings, then say “kik” and talk.";
    wrap.append(e);
  }
  for (const h of rows) {
    const you = document.createElement("div");
    you.className = "chat-you";
    you.textContent = h.text;
    wrap.append(you);
    if (h.said) {
      const kik = document.createElement("div");
      kik.className = "chat-kik";
      kik.textContent = h.said;
      wrap.append(kik);
    }
  }
  if (liveYou) {
    const you = document.createElement("div");
    you.className = "chat-you live";
    you.textContent = liveYou;
    wrap.append(you);
  }
  if (thinking) {
    const dots = document.createElement("div");
    dots.className = "chat-thinking";
    dots.innerHTML = "<i></i><i></i><i></i>";
    wrap.append(dots);
  }
  if (suggestions.length) {
    const chips = document.createElement("div");
    chips.className = "chat-chips";
    for (const s of suggestions) {
      const c = document.createElement("button");
      c.type = "button";
      c.textContent = s;
      c.addEventListener("click", () => {
        suggestions = [];
        window.room.sayToKik(s);
      });
      chips.append(c);
    }
    wrap.append(chips);
  }
  wrap.append(replyBox("type to kik…"));
  return wrap;
}

/** A checklist: '- [ ] item' lines you can tick; the body is the state. */
function checklistBody(p) {
  const list = document.createElement("div");
  list.className = "checklist";
  const lines = p.body.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = /^\s*(?:[-*]\s*)?\[( |x|X)\]\s*(.*)$/.exec(line);
    const text = m ? m[2] : line.replace(/^\s*[-*]\s*/, "");
    if (!text.trim()) return;
    const row = document.createElement("label");
    row.className = "check-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = Boolean(m && m[1].toLowerCase() === "x");
    const span = document.createElement("span");
    span.textContent = text;
    if (box.checked) row.dataset.done = "1";
    box.addEventListener("change", () => {
      lines[i] = `- [${box.checked ? "x" : " "}] ${text}`;
      window.room.updatePin(p.id, { body: lines.join("\n") });
    });
    row.append(box, span);
    list.append(row);
  });
  const add = document.createElement("form");
  add.className = "check-add";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "add an item…";
  add.append(input);
  add.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    window.room.updatePin(p.id, { body: `${p.body.trimEnd()}\n- [ ] ${t}` });
  });
  list.append(add);
  return list;
}

/** A note: yours to edit in place. */
function noteBody(p) {
  const box = document.createElement("div");
  box.className = "note-edit";
  box.contentEditable = "true";
  box.spellcheck = false;
  box.textContent = p.body;
  box.addEventListener("blur", () => {
    const body = box.textContent ?? "";
    if (body !== p.body) window.room.updatePin(p.id, { body });
  });
  box.addEventListener("keydown", (e) => e.stopPropagation());
  return box;
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
    m.textContent = h.text ? `“${h.text}”` : `not for me · ${h.words ?? "?"} words · dropped`;
    if (h.text && h.kind === "overheard") d.dataset.debug = "1";
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
  thinking(f) {
    if (state) state.thinking = f.thoughts ?? [];
    renderBoard();
  },
  hello(f) {
    sessions = f.sessions ?? {};
    mode = f.mode ?? mode;
    renderAgents();
    rest();
    window.room.state().then((s) => {
      if (!s) return;
      state = s;
      applyLook(s.look);
      pins = s.pins ?? [];
      asking = s.asking ?? null;
      pendingPermission = s.pending_permission ? { ...s.pending_permission, text: "" } : null;
      for (const h of [...(s.history ?? [])].reverse().slice(-2)) pushHistory(h.text);
      renderBoard();
      renderAgents();
      rest();
    });
  },
  focus(f) {
    if (f.id) window.board.focus(String(f.id));
  },
  suggest(f) {
    suggestions = Array.isArray(f.options) ? f.options.map(String) : [];
    renderBoard();
  },
  look(f) {
    applyLook(f);
  },
  sessions(f) {
    sessions = f.sessions ?? {};
    renderBoard();
    renderAgents();
    if (el.body.dataset.view === "control") showControl();
    if (el.body.dataset.idle === "true") rest();
  },
  mode(f) {
    mode = f.mode ?? mode;
    renderAgents();
  },
  event(f) {
    if (f.repo) {
      const list = recentEvents.get(f.repo) ?? [];
      const text =
        f.kind === "permission"
          ? `asked: ${f.text || (f.args?.command ?? "a tool call")}`
          : f.kind === "error"
            ? `error: ${(f.text ?? "").slice(0, 80)}`
            : f.kind === "turn_end"
              ? `done: ${(f.text ?? "").slice(0, 80) || "turn ended"}`
              : f.tool
                ? `${f.tool.toLowerCase()} ${f.status ?? ""}`.trim()
                : f.kind;
      list.unshift({ ts: f.ts ?? Date.now() / 1000, kind: f.kind, text });
      recentEvents.set(f.repo, list.slice(0, 5));
      renderBoard();
    }
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
      thinking = false;
      renderBoard();
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
    if (f.phase === "transcribing") {
      setOrb("listening", "one moment");
      // if nothing follows, the transcript was lost somewhere; do not sit here
      clearTimeout(micWatchdog);
      micWatchdog = setTimeout(() => {
        if (el.orbLabel.textContent === "one moment") setOrb("idle", "listening");
      }, 6000);
      return;
    }
    if (f.phase === "addressed") {
      liveYou = f.text ?? "";
      thinking = false;
      renderBoard();
      setOrb("listening", "heard you");
      el.lineRepo.textContent = "you said";
      el.lineText.textContent = `“${f.text}”`;
      el.lineHint.textContent = "";
      return;
    }
    if (f.phase === "overheard") {
      setOrb("idle", "not for me");
      overheardUntil = Date.now() + 2500;
      setTimeout(() => {
        if (el.orbLabel.textContent === "not for me" && !speaking) setOrb("idle", "listening");
      }, 2600);
      return;
    }
    if (f.phase === "thinking") {
      thinking = true;
      renderBoard();
      return setOrb("speaking", "thinking");
    }
    if (f.phase === "attending") {
      attendingUntil = Number(f.until) || Date.now() + 20000;
      if (!speaking) setOrb("listening", "with you");
      clearTimeout(attendingTimer);
      attendingTimer = setTimeout(
        () => {
          if (el.orbLabel.textContent === "with you") setOrb("idle", "listening");
        },
        Math.max(0, attendingUntil - Date.now()),
      );
      return;
    }
    if (f.phase === "idle" && !speaking) {
      if (Date.now() < overheardUntil) return; // let "not for me" be read
      if (Date.now() < attendingUntil) return setOrb("listening", "with you");
      if (pendingPermission) return showPermission();
      if (asking) return showAsking();
      setOrb("idle", "listening");
    }
  },
  view(f) {
    if (f.view === "control") showControl();
    else showRoom();
  },
  heard(f) {
    liveYou = "";
    thinking = false;
    // the conversation card on the canvas shows it at once
    if (state && f && f.text)
      state.heard = [
        { text: f.text, kind: f.kind, intent: f.intent, said: f.said, ts: Date.now() / 1000 },
        ...(state.heard ?? []),
      ].slice(0, 30);
    renderBoard();
    if (el.body.dataset.view === "control") showControl();
  },
  /**
   * Another project's board, whole, in one frame so the swap is one render
   * rather than a flicker of cards arriving.
   */
  project(f) {
    state.project = { id: f.id, name: f.name, all: f.projects ?? [] };
    pins = Array.isArray(f.pins) ? f.pins : [];
    asking = pins.find((p) => p.ask?.length && p.answer === null)?.id ?? null;
    window.board?.reset();
    renderBoard();
    renderAgents();
    renderProject();
  },
  pin(f) {
    // A card for a project you are not looking at still exists; it is just
    // not on this screen. You see it when you open that project.
    const here = state.project?.id;
    if (f.op === "add" && here !== undefined && f.project !== undefined && f.project !== here) {
      return;
    }
    if (f.op === "add" && f.pin) {
      pins = [...pins.filter((p) => p.id !== f.pin.id), f.pin];
      if (f.pin.ask.length) asking = f.pin.id;
    } else if (f.op === "answer" && f.pin) {
      pins = pins.map((p) => (p.id === f.pin.id ? f.pin : p));
      if (asking === f.pin.id) asking = null;
    } else if (f.op === "update" && f.pin) {
      pins = pins.map((p) => (p.id === f.pin.id ? f.pin : p));
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
