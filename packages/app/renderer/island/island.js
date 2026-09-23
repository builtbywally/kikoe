// The island's state machine.
//
// The daemon sends what happened; this decides what is shown. The rule it
// follows is the narrator's: default to the quiet state, and only rise above it
// for something a person would look up for. A HUD that reacts to every tool
// event is the visual version of narrating every file read.
//
// Two surfaces, and the split is the whole design:
//
//   the pill    one row, always. Glanced at. Says what is happening *now*, in
//               two or three words. Text that does not fit is truncated, never
//               wrapped — a pill that grows a line is one you read instead of
//               glance at.
//   the panel   read, not glanced at. Only exists when there is something worth
//               reading: the agent's plan, the command it is about to run, the
//               shape of an edit. This is the one place code and file paths
//               belong, because they are unbearable spoken and are the most
//               useful thing there is on a screen.
//
// It is a display with exactly one control. Per-turn buttons were tried and
// were wrong: the premise is that your attention is elsewhere, so a small
// target needing a mouse asks for what you do not have; if you are at the
// machine, the terminal prompt is the real UI; and the states worth acting on
// last seconds, so clicking one is a race. Answering happens by voice, or in
// the terminal.
//
// The gear is the exception, and it is one for the opposite reasons: choosing
// an audio device is deliberate, rare, done while you are sitting here, and
// racing nothing. It also cannot be done by voice — the whole difficulty is
// that three identically-named endpoints are indistinguishable until you hear
// one of them.

const el = {
  island: document.getElementById("island"),
  text: document.getElementById("text"),
  state: document.getElementById("state"),
  panel: document.getElementById("panel"),
  panelTitle: document.getElementById("panel-title"),
  panelBody: document.getElementById("panel-body"),
  gear: document.getElementById("gear"),
  settings: document.getElementById("settings"),
  settingsClose: document.getElementById("settings-close"),
  outputs: document.getElementById("outputs"),
  inputs: document.getElementById("inputs"),
  note: document.getElementById("settings-note"),
  rings: document.getElementById("rings"),
  ringsRule: document.getElementById("rings-rule"),
  usageCard: document.getElementById("usage-card"),
  usageTail: document.getElementById("usage-tail"),
  usageGlyph: document.getElementById("usage-glyph"),
  usageTitle: document.getElementById("usage-title"),
  usagePlan: document.getElementById("usage-plan"),
  usageBody: document.getElementById("usage-body"),
};

// How long a transient state holds before falling back to what the session is
// actually doing. Speech and thinking clear themselves on their own frames.
const HOLD = { heard: 5000, overheard: 2600, error: 8000, done: 5000 };

// A plan outlives the tool call that produced it; a command does not.
const DETAIL_TTL = { plan: 240000, code: 45000, command: 30000, file: 30000 };

let sessions = {};
let pendingPermission = null;
let detail = null;
let holdTimer = null;
let detailTimer = null;
let quietTimer = null;
let lastSpokeAt = 0;
let current = "disconnected";
// The mark is a thought-orb (Thinking Orbs, the 20-pixel preset): the pill's
// state as one of its verbs. The pill is always dark, so the ink is light.
const islandOrb = window.KikOrb?.create(document.getElementById("orb-dots"), {
  size: 20,
  dark: true,
});

function render(state, { label, text = "", quote = false } = {}) {
  // Any pending fallback belongs to the state we are leaving. Without this a
  // hold set for "overheard" fires 2.6s later and drops a live "speaking" back
  // to idle mid-sentence — a race that only shows up when you talk quickly.
  clearTimeout(holdTimer);
  holdTimer = null;
  current = state;
  el.island.dataset.state = state;
  islandOrb?.set(window.KikOrb.forKik(state === "permission" ? "asking" : state));
  el.state.textContent = label;
  el.text.textContent = quote && text ? `“${text}”` : text;
}

function showDetail(next) {
  clearTimeout(detailTimer);
  const lines = next && Array.isArray(next.lines) ? next.lines : [];
  detail = next?.kind && lines.length ? { ...next, lines } : null;

  if (!detail) {
    el.panel.hidden = true;
    return;
  }

  el.panel.hidden = false;
  el.panel.dataset.kind = detail.kind;
  el.panelTitle.textContent = [detail.repo, detail.title].filter(Boolean).join(" · ");

  el.panelBody.textContent = "";
  for (const line of detail.lines) {
    const row = document.createElement("span");
    if (detail.kind === "plan") {
      // The mark carries the meaning: done recedes, the current line is the
      // accent, the rest is ordinary text.
      row.className = line.startsWith("[x]") ? "done" : line.startsWith("[>]") ? "now" : "next";
    }
    row.textContent = line + "\n";
    el.panelBody.appendChild(row);
  }

  const ttl = DETAIL_TTL[detail.kind] || 30000;
  detailTimer = setTimeout(() => showDetail(null), ttl);
}

// What to show when nothing is demanding attention.
function rest() {
  if (pendingPermission) return showPermission(pendingPermission);

  const rows = Object.values(sessions).filter(Boolean);

  // A session blocked on a human outranks one merrily working. This also
  // recovers the state after a reconnect: `pendingPermission` only ever comes
  // from a live frame, so an island started while a prompt was already up used
  // to show idle. The tracker knew; nothing asked it.
  const blocked = rows.find((s) => s.status === "waiting");
  if (blocked) {
    return render("permission", {
      label: "needs you",
      text: blocked.pending_permission || blocked.label || blocked.repo || "",
    });
  }

  // "working" is the tracker's word. "busy" was never one of them.
  const busy = rows.find((s) => s.status === "working");
  if (busy) {
    const bits = [busy.repo || busy.label, busy.current_tool || busy.tool]
      .filter(Boolean)
      .join(" · ");
    return render("working", { label: "working", text: bits });
  }
  return render("idle", { label: "idle" });
}

function hold(state, ms, payload) {
  render(state, payload); // clears any previous hold
  holdTimer = setTimeout(rest, ms);
}

function commandOf(args = {}) {
  return args.command || args.file_path || args.path || args.pattern || args.url || "";
}

function showPermission(p) {
  render("permission", {
    label: "needs you",
    text: commandOf(p.args) || p.text || "waiting on a decision",
  });
}

const handlers = {
  hello(f) {
    sessions = f.sessions || {};
    // Archived readings ride in on the hello, so an island started long after
    // the last poll draws the numbers it had rather than empty circles.
    renderRings(f.usage);
    rest();
  },

  usage(f) {
    renderRings(f.providers);
  },

  sessions(f) {
    sessions = f.sessions || {};
    // The inner arc is the tracker's own fact, not the endpoint's, so it moves
    // with the sessions rather than waiting for the next poll.
    renderRings(usageProviders);
    // Never let a routine update paper over something that needs a human, cut
    // a line off mid-sentence, or stomp a state the user is still reading.
    if (
      [
        "permission",
        "speaking",
        "thinking",
        "transcribing",
        "overheard",
        "listening",
        "heard",
        "done",
        "error",
      ].includes(current)
    ) {
      return;
    }
    rest();
  },

  detail(f) {
    showDetail(f);
  },

  event(f) {
    if (f.kind === "permission") {
      pendingPermission = f;
      return showPermission(f);
    }
    if (f.kind === "error") {
      return hold("error", HOLD.error, { label: "error", text: f.text || "" });
    }
    // A permission answered by voice or in the terminal must clear here too,
    // or the island keeps asking for something already dealt with — but only
    // the session that asked may clear it. With two agents running, the other
    // one finishing a tool call was wiping a prompt that was still waiting.
    if (
      pendingPermission &&
      (f.kind === "tool_end" || f.kind === "turn_end") &&
      (!f.session || !pendingPermission.session || f.session === pendingPermission.session)
    ) {
      pendingPermission = null;
      // Only if the pill is still showing that permission. Unguarded, this
      // dropped whatever had replaced it — usually a line being spoken.
      if (current === "permission") rest();
    }

    // A finished turn deserves a moment. Without it the pill drops straight to
    // idle and the outcome — which is the only part you actually wanted — is
    // gone before you look up. Shape: checkmark, then what happened, then
    // where.
    if (f.kind === "turn_end") {
      // Not while it is talking. The spoken line *is* the outcome, and cutting
      // it off to show a checkmark trades the better report for the worse one.
      if (current === "speaking" || Date.now() - lastSpokeAt < 400) return;
      // Nor over your own turn. With two agents running, the other one
      // finishing was stamping ✓ over the pill for the thing you just said.
      if (["heard", "transcribing", "thinking", "listening", "permission"].includes(current))
        return;
      const s = sessions[f.session] || {};
      const outcome = [s.last_test_result, f.repo || s.repo || s.label].filter(Boolean).join(" · ");
      return hold("done", HOLD.done, { label: "✓ done", text: outcome });
    }
  },

  speech(f) {
    if (f.phase === "speaking") {
      clearTimeout(quietTimer);
      lastSpokeAt = Date.now();
      return render("speaking", { label: "speaking", text: f.text || "" });
    }
    if (f.phase === "interrupted") {
      // The queue was thrown away — only the arbiter knows that. Nothing more
      // is coming, so do not wait for the debounce.
      clearTimeout(quietTimer);
      if (current === "speaking") rest();
      return;
    }
    // Debounced anyway: a clause boundary can briefly look like silence while
    // the next one is still being synthesised.
    if (current === "speaking") {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (current === "speaking") rest();
      }, 600);
    }
  },

  mic(f) {
    if (f.phase === "hearing") {
      return render("listening", { label: "listening" });
    }
    if (f.phase === "partial") {
      // Your words, as you are still saying them. Rough on purpose — a smaller
      // model at beam 1 — because this is a "the words are landing" signal,
      // not a transcript. Nothing downstream reads it.
      return render("listening", { label: "listening", text: f.text || "", quote: true });
    }
    if (f.phase === "transcribing") {
      // The gap that used to show nothing at all: key released, nothing said
      // yet. Without a state here a working system looks like a dead one.
      return render("transcribing", { label: "transcribing" });
    }
    if (f.phase === "thinking") {
      // Showing the words back is the confirmation that matters — it is the
      // only way to know it heard the sentence you actually said.
      return render("thinking", { label: "thinking", text: f.text || "", quote: true });
    }
    if (f.phase === "overheard") {
      // The state that makes an open mic trustworthy: it heard you, and
      // decided you were not talking to it.
      return hold("overheard", HOLD.overheard, {
        label: "overheard",
        text: f.text || "",
        quote: true,
      });
    }
    if (f.phase === "addressed") {
      return hold("listening", HOLD.heard, {
        label: "heard you",
        text: f.text || "",
        quote: true,
      });
    }
    if (f.phase === "idle") {
      // Everything the mic loop can be in the middle of. `thinking` was
      // missing, so a control command — "stop", "go verbose" — which is
      // handled locally and never spoken left the pill reading THINKING
      // forever, with no frame able to clear it.
      // "overheard" is deliberately absent: the loop publishes it and then
      // goes idle in the same breath, so listing it here meant the state that
      // makes an open mic trustworthy was erased microseconds after it drew.
      // Its own hold expires it.
      if (["listening", "transcribing", "thinking"].includes(current)) {
        rest();
      }
    }
  },
};

// --- usage rings -----------------------------------------------------------
//
// What is left of each coding assistant's limit. The idea, the ring, the bands
// and the card are Codenotch's (github.com/vinzdg/codenotch), which pins the
// same reading to a macOS screen edge; the daemon's usage.ts holds the parsers
// and says where each number is borrowed from.
//
// Three of its rules matter more than the drawing:
//
//   a missing reading is a dash, never a zero — "0%" is a claim, and a ring
//   that has never succeeded is not entitled to make it;
//   an old reading is shown dimmed with its age, because a number with a date
//   on it beats no number;
//   whether an agent is *working* is known first-hand from Kikoe's own hooks,
//   so it stays at full strength even when the percentage behind it is stale.
//
// Display only, like the rest of the pill. Hovering a ring opens its card and
// that is the entire interaction: the window stays click-through, because
// mouse *moves* are forwarded to the page even when clicks are not.

/** The arc's radius in the 24-unit box, and the circumference that follows. */
const RING_R = 10.4;
const RING_C = 2 * Math.PI * RING_R;

/** Codenotch's thresholds. Kept in step with `band()` in daemon/src/usage.ts. */
function bandOf(used) {
  if (used >= 1) return "spent";
  if (used >= 0.7) return "critical";
  if (used >= 0.5) return "watch";
  return "ample";
}

/**
 * A radial burst as line segments.
 *
 * Ray count is a size decision, not a brand one: below about 24px a twelve-ray
 * mark turns to mush, which is why the orb at the other end of this pill drops
 * every other ray too. Inside a ring the mark is barely 9px across, so six is
 * what survives.
 */
function burst(rays, inner, outer) {
  const out = [];
  for (let i = 0; i < rays; i++) {
    const a = (i * 2 * Math.PI) / rays - Math.PI / 2;
    out.push([
      12 + inner * Math.cos(a),
      12 + inner * Math.sin(a),
      12 + outer * Math.cos(a),
      12 + outer * Math.sin(a),
    ]);
  }
  return out;
}

const SVG = "http://www.w3.org/2000/svg";

function svgEl(name, attrs) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  return node;
}

/**
 * The provider's mark, drawn into a 24-unit box centred on 12,12.
 *
 * Deliberately simple strokes rather than traced logos: at this size a traced
 * outline is indistinguishable from a blob, and a blob that claims to be
 * someone's trademark is worse than an honest glyph. `scale` grows the same
 * drawing for the card, where there is room for the detail.
 */
function glyphFor(name, scale = 1) {
  const g = svgEl("g", { class: "ring-glyph" });
  const s = (v) => 12 + (v - 12) * scale;
  const line = (x1, y1, x2, y2) =>
    g.appendChild(svgEl("line", { x1: s(x1), y1: s(y1), x2: s(x2), y2: s(y2) }));

  if (name === "opencode") {
    // A prompt: the chevron and the caret under it. Says "a coding CLI"
    // without pretending to be anyone's logo.
    g.appendChild(
      svgEl("polyline", {
        points: `${s(9.7)},${s(9)} ${s(13)},${s(12)} ${s(9.7)},${s(15)}`,
        fill: "none",
      }),
    );
    line(14.4, 15, 16.6, 15);
    return g;
  }
  // claude, and the fallback: the asterisk.
  for (const [x1, y1, x2, y2] of burst(scale > 1.4 ? 12 : 6, 1.5, 4.6)) line(x1, y1, x2, y2);
  return g;
}

/** One ring and its number. Built once, then updated in place so the arc sweeps. */
function ringCell(provider) {
  const cell = document.createElement("div");
  cell.className = "ring-cell";
  cell.dataset.id = provider.id;

  const svg = svgEl("svg", { class: "ring", viewBox: "0 0 24 24", width: 23, height: 23 });
  svg.append(
    svgEl("circle", { class: "ring-track", cx: 12, cy: 12, r: RING_R }),
    svgEl("circle", {
      class: "ring-arc",
      cx: 12,
      cy: 12,
      r: RING_R,
      "stroke-dasharray": RING_C,
      "stroke-dashoffset": RING_C,
    }),
    glyphFor(provider.glyph),
    // A quarter of the circle, so the spin has something to read against.
    svgEl("circle", {
      class: "ring-activity",
      cx: 12,
      cy: 12,
      r: 7.4,
      "stroke-dasharray": `${2 * Math.PI * 7.4 * 0.25} ${2 * Math.PI * 7.4}`,
    }),
  );

  const pct = document.createElement("span");
  pct.className = "ring-pct";
  cell.append(svg, pct);
  return cell;
}

let usageProviders = [];
let usageCells = new Map();
let hoveredRing = null;

/** Which window the ring itself means, and how full it is. */
function headlineOf(provider) {
  const windows = provider.windows || [];
  return windows.find((w) => w.id === provider.headline) || windows[0] || null;
}

function renderRings(providers) {
  usageProviders = Array.isArray(providers) ? providers : [];
  const ids = usageProviders.map((p) => p.id).join(",");
  if (ids !== [...usageCells.keys()].join(",")) {
    el.rings.textContent = "";
    usageCells = new Map();
    for (const provider of usageProviders) {
      const cell = ringCell(provider);
      usageCells.set(provider.id, cell);
      el.rings.append(cell);
    }
  }
  el.ringsRule.hidden = !usageProviders.length;

  for (const provider of usageProviders) {
    const cell = usageCells.get(provider.id);
    if (!cell) continue;
    const window = headlineOf(provider);
    const used = window ? Math.min(Math.max(window.used, 0), 1) : 0;
    cell.dataset.status = provider.status;
    cell.dataset.reading = window ? "some" : "none";
    cell.dataset.band = window ? bandOf(used) : "ample";
    cell.dataset.activity = activityFor(provider.id);
    cell.querySelector(".ring-arc").setAttribute("stroke-dashoffset", RING_C * (1 - used));
    // A dash, not "0%": nothing read is not the same as nothing used.
    cell.querySelector(".ring-pct").textContent = window ? `${Math.round(used * 100)}%` : "—";
  }
  if (hoveredRing) fillUsageCard(hoveredRing);
}

/**
 * Whether that assistant is doing something right now.
 *
 * Every session Kikoe sees comes through Claude Code's hooks, and a hook says
 * nothing about which configuration directory it was launched from — so the
 * work is attributed to the default profile and not guessed at for the others.
 */
function activityFor(id) {
  if (id !== "claude") return "idle";
  const rows = Object.values(sessions).filter(Boolean);
  if (rows.some((s) => s.status === "waiting")) return "waiting";
  if (rows.some((s) => s.status === "working")) return "working";
  return "idle";
}

/** Sessions the ring's card lists under its hairline. */
function sessionsFor(id) {
  if (id !== "claude") return [];
  return Object.values(sessions)
    .filter((s) => s && (s.status === "working" || s.status === "waiting"))
    .slice(0, 4);
}

function row(cls, text) {
  const node = document.createElement("div");
  node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function fillUsageCard(provider) {
  el.usageGlyph.textContent = "";
  const mark = svgEl("svg", { viewBox: "0 0 24 24", width: 15, height: 15 });
  mark.append(glyphFor(provider.glyph, 1.5));
  el.usageGlyph.append(mark);
  el.usageTitle.textContent = `${provider.name} usage`;
  el.usagePlan.textContent = provider.plan || "";

  el.usageBody.textContent = "";
  const windows = provider.windows || [];
  for (const w of windows) {
    const used = Math.min(Math.max(w.used, 0), 1);
    const block = row("usage-row");
    block.dataset.band = bandOf(used);

    const line = row("usage-line");
    line.append(row("what", w.label));
    if (w.resets_at) line.append(row("usage-when", resetCopy(w.resets_at)));
    block.append(line);

    const bar = row("usage-bar");
    const fill = row("usage-fill");
    fill.style.width = `${used * 100}%`;
    bar.append(fill);
    block.append(bar, row("usage-used", `${Math.round(used * 100)}% used`));
    el.usageBody.append(block);
  }

  // Why there is no number, or why the one above is old. Never a status where
  // a reading should be with nothing said about it.
  const stale = provider.status === "stale" || provider.status === "rate_limited";
  if (!windows.length || stale) {
    const note = row("usage-note");
    note.dataset.tone = windows.length ? "" : "bad";
    note.textContent = [stale && windows.length ? ageCopy(provider.read_at) : "", provider.message]
      .filter(Boolean)
      .join(" · ");
    if (note.textContent) el.usageBody.append(note);
  }

  const live = sessionsFor(provider.id);
  if (live.length) {
    const group = row("usage-live");
    for (const s of live) {
      const line = row("usage-session");
      line.dataset.status = s.status;
      line.append(row("where", s.repo || s.label || "an agent"));
      line.append(
        row(
          "what",
          s.status === "waiting"
            ? s.pending_permission || "needs you"
            : s.current_tool || s.tool || "working",
        ),
      );
      group.append(line);
    }
    el.usageBody.append(group);
  }
}

/** "resets in 51 min", "resets Thu 12:00 am", "resets Sep 28" — see usage.ts. */
function resetCopy(at, now = Date.now()) {
  const seconds = (at - now) / 1000;
  if (seconds <= 0) return "resetting…";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `resets in ${Math.max(1, minutes)} min`;
  const when = new Date(at);
  const days = Math.round(
    (new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000,
  );
  if (days >= 7) return `resets ${when.toLocaleDateString([], { month: "short", day: "numeric" })}`;
  const time = when
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    .replace(/\s+/g, " ");
  return `resets ${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function ageCopy(readAt) {
  if (!readAt) return "never read";
  const minutes = Math.floor((Date.now() - readAt) / 60000);
  if (minutes < 1) return "read just now";
  if (minutes < 60) return `read ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `read ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `read ${days} ${days === 1 ? "day" : "days"} ago`;
}

function showUsageCard(provider, cell) {
  hoveredRing = provider;
  fillUsageCard(provider);
  el.usageCard.hidden = false;
  // The tail points at the ring's centre, and the card is centred under it
  // until an edge stops it. Measured against the wrap, which is what the card
  // is positioned in.
  const wrap = document.querySelector(".wrap").getBoundingClientRect();
  const ring = cell.querySelector(".ring").getBoundingClientRect();
  const centre = ring.left + ring.width / 2 - wrap.left;
  const width = el.usageCard.getBoundingClientRect().width;
  const left = Math.min(Math.max(centre - width / 2, 0), Math.max(0, wrap.width - width));
  el.usageCard.style.left = `${left}px`;
  el.usageTail.style.left = `${centre - left}px`;
  // Four limit windows and four live sessions run past the window's resting
  // height, and anything past it is simply not drawn — so the window grows to
  // whatever the card actually measured.
  fitWindow();
}

function hideUsageCard() {
  hoveredRing = null;
  el.usageCard.hidden = true;
  fitWindow();
}

/** Hit-test the rings on every move. No hover CSS: see the note at the top. */
function trackRingHover(x, y) {
  for (const provider of usageProviders) {
    const cell = usageCells.get(provider.id);
    if (!cell) continue;
    const r = cell.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      if (hoveredRing?.id !== provider.id) showUsageCard(provider, cell);
      return;
    }
  }
  if (hoveredRing) hideUsageCard();
}

// --- audio settings --------------------------------------------------------
//
// Click-through is the invariant here, and the failure to avoid is a HUD stuck
// swallowing every click at the top of the screen. So the window is only ever
// interactive while the pointer is demonstrably inside the gear or the open
// panel, and every path that could end that — leaving the window, closing the
// panel, an error — puts it back.

let settingsOpen = false;

function hotRects() {
  const rects = [el.gear.getBoundingClientRect()];
  if (settingsOpen) rects.push(el.settings.getBoundingClientRect());
  return rects;
}

function inHotZone(x, y) {
  return hotRects().some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
}

let interactive = false;
function setInteractive(on) {
  if (on === interactive) return;
  interactive = on;
  window.island.setInteractive(on);
}

// Mouse moves are forwarded to the page even while clicks pass through, which
// is what makes this possible: the page can see the pointer arrive without the
// window having claimed it first.
document.addEventListener("mousemove", (e) => {
  setInteractive(inHotZone(e.clientX, e.clientY));
  trackRingHover(e.clientX, e.clientY);
});

// Leaving the window entirely produces no further moves, so without this the
// window could stay interactive with the pointer somewhere else — and a card
// opened by the last move in could stay open for ever.
document.addEventListener("mouseleave", () => {
  setInteractive(false);
  hideUsageCard();
});
window.addEventListener("blur", () => {
  setInteractive(false);
  hideUsageCard();
});

function note(text, tone = "") {
  el.note.textContent = text || "";
  el.note.dataset.tone = tone;
}

function deviceRow(kind, device, chosen) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "dev";
  row.dataset.chosen = String(chosen);

  const tick = document.createElement("span");
  tick.className = "tick";
  tick.textContent = chosen ? "•" : "";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = device.name;

  const api = document.createElement("span");
  api.className = "api";
  // Only the distinguishing part. "Windows WASAPI" three times down a list is
  // noise; "WASAPI" next to "MME" is the whole point.
  api.textContent = (device.api || "").replace(/^Windows /, "");

  const test = document.createElement("button");
  test.type = "button";
  test.className = "test";
  test.textContent = kind === "output" ? "test" : "level";

  test.addEventListener("click", async (e) => {
    e.stopPropagation(); // testing is not choosing
    test.dataset.busy = "true";
    test.textContent = kind === "output" ? "playing" : "listening";
    note(kind === "output" ? "playing a tone…" : "say something…");
    const res = await window.island.testDevice(kind, device.name);
    delete test.dataset.busy;
    test.textContent = kind === "output" ? "test" : "level";
    if (res?.error) return note(res.error, "bad");
    if (kind === "output") {
      // Deliberately a question. Frames left the process; whether a human
      // heard them is not something this program can ever know, and every
      // previous claim that it could was wrong.
      return note("played a tone through " + device.name + " — hear it?");
    }
    const heard = res?.peak || 0;
    note(
      heard > 400
        ? "picked you up (peak " + heard + ")"
        : "heard almost nothing (peak " + heard + ")",
      heard > 400 ? "good" : "bad",
    );
  });

  row.addEventListener("click", async () => {
    note("switching…");
    const res = await window.island.chooseDevice(kind, device.name);
    if (res?.error) return note(res.error, "bad");
    await loadDevices();
    note(
      res?.restart_required
        ? "saved — the microphone changes on the next start"
        : "now using " + (res.bound || device.name),
      "good",
    );
  });

  row.append(tick, name, api, test);
  return row;
}

async function loadDevices() {
  const info = await window.island.devices();
  if (!info || info.error) {
    note(info?.error || "could not reach the daemon", "bad");
    return;
  }
  const fill = (host, list, chosenSpec, kind) => {
    host.textContent = "";
    const needle = String(chosenSpec || "").toLowerCase();
    for (const device of list || []) {
      const chosen = !!needle && device.name.toLowerCase().includes(needle);
      host.append(deviceRow(kind, device, chosen));
    }
    if (!(list || []).length) {
      const empty = document.createElement("div");
      empty.className = "dev-note";
      empty.textContent = "none found";
      host.append(empty);
    }
  };
  fill(el.outputs, info.outputs, info.output, "output");
  fill(el.inputs, info.inputs, info.input, "input");
}

// Measured, not guessed: the panel's height depends on how many devices the
// machine has, which is not knowable ahead of time.
function fitWindow() {
  const wrap = document.querySelector(".wrap");
  if (!wrap) return;
  // The usage card is positioned absolutely, so it is not in the wrap's box and
  // has to be measured on its own or a tall one is simply cut off.
  const bottom = Math.max(
    wrap.getBoundingClientRect().bottom,
    el.usageCard.hidden ? 0 : el.usageCard.getBoundingClientRect().bottom,
  );
  window.island.setHeight(Math.ceil(bottom) + 24);
}

function openSettings() {
  settingsOpen = true;
  el.settings.hidden = false;
  el.gear.setAttribute("aria-expanded", "true");
  note("loading…");
  fitWindow();
  loadDevices().then(fitWindow);
}

function closeSettings() {
  settingsOpen = false;
  el.settings.hidden = true;
  el.gear.setAttribute("aria-expanded", "false");
  note("");
  setInteractive(false);
  fitWindow();
}

// The gear opens the app's Settings window. The pill stays a display: the
// in-pill device panel is gone, so the only thing the gear ever does is hand
// you to a real window that can afford controls.
el.gear.addEventListener("click", () => {
  if (settingsOpen) closeSettings();
  window.island.openSettings();
});
el.settingsClose.addEventListener("click", closeSettings);

window.island.stream(
  (frame) => {
    const fn = handlers[frame.type];
    if (fn) fn(frame);
  },
  (status) => {
    if (status === "disconnected") {
      pendingPermission = null;
      showDetail(null);
      hideUsageCard();
      // The rings stay. A limit does not reset because the daemon dropped, and
      // the hello frame will correct them the moment it reconnects.
      render("disconnected", { label: "no daemon" });
    }
  },
);
