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

function render(state, { label, text = "", quote = false } = {}) {
  // Any pending fallback belongs to the state we are leaving. Without this a
  // hold set for "overheard" fires 2.6s later and drops a live "speaking" back
  // to idle mid-sentence — a race that only shows up when you talk quickly.
  clearTimeout(holdTimer);
  holdTimer = null;
  current = state;
  el.island.dataset.state = state;
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
    rest();
  },

  sessions(f) {
    sessions = f.sessions || {};
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
});

// Leaving the window entirely produces no further moves, so without this the
// window could stay interactive with the pointer somewhere else.
document.addEventListener("mouseleave", () => setInteractive(false));
window.addEventListener("blur", () => setInteractive(false));

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
  if (wrap) window.island.setHeight(Math.ceil(wrap.getBoundingClientRect().bottom) + 24);
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
      render("disconnected", { label: "no daemon" });
    }
  },
);
