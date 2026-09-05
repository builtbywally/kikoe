// Settings and the first-run flow. One page at a time; everything talks to
// the main process through the named calls the preload exposes.

const $ = (id) => document.getElementById(id);
const api = window.kikoe;
let info = null;
let onboarding = false;
let sessionsTimer = null;

const LINES = {
  piper: "Tests pass. Eighteen passed, two failed, all Windows path stuff.",
  kokoro: "Race is fixed. Three tests still failing.",
  eleven: "It wants to push. Shall I?",
  system: "Done. Fixed the race in token refresh.",
};

function note(id, text, tone = "") {
  const el = $(id);
  el.textContent = text || "";
  el.dataset.tone = tone;
}

function show(page) {
  for (const s of document.querySelectorAll(".page")) s.hidden = s.id !== `page-${page}`;
  for (const b of document.querySelectorAll("#nav button")) {
    if (b.dataset.page === page) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  clearInterval(sessionsTimer);
  if (page === "doctor") renderDoctor();
  if (page === "hooks") previewHooks();
  if (page === "sessions") {
    renderSessions();
    sessionsTimer = setInterval(renderSessions, 2000);
  }
}

async function load() {
  info = await api.get();
  $("version").textContent = info.version;
  const s = info.settings;
  const tts =
    s.tts === "auto" ? (info.hasElevenKey && s.elevenlabs_voice ? "eleven" : "piper") : s.tts;
  const r = document.querySelector(`input[name=tts][value=${tts}]`);
  if (r) r.checked = true;
  $("strict").checked = Boolean(s.tts_strict);
  const n = document.querySelector(`input[name=narrate][value=${s.narrate}]`);
  if (n) n.checked = true;
  const ec = document.querySelector(`input[name=earcons][value=${s.earcons || "cues"}]`);
  if (ec) ec.checked = true;
  const p = document.querySelector(`input[name=profile][value=${s.hook_profile}]`);
  if (p) p.checked = true;
  $("login").checked = Boolean(info.loginItem);
  $("mic").checked = Boolean(s.mic);
  const th = document.querySelector(`input[name=theme][value=${s.theme || "system"}]`);
  if (th) th.checked = true;
  $("wake").value = s.wake_name || "kikoe";
  api.inputDevices().then((r) => {
    if (!r.ok) return;
    const sel = $("mic-device");
    sel.innerHTML = '<option value="">default microphone</option>';
    for (const d of r.devices) {
      const o = document.createElement("option");
      o.value = d.name;
      o.textContent = d.name + (d.default ? " (default)" : "");
      sel.appendChild(o);
    }
    if (s.mic_device)
      sel.value =
        [...sel.options].find((o) => o.value.toLowerCase().includes(s.mic_device.toLowerCase()))
          ?.value ?? "";
  });
  $("claude-path").textContent = info.claudeSettingsPath;
  $("eleven-key").placeholder = info.hasElevenKey
    ? "key saved in the keychain (paste to replace)"
    : "API key (stored in the OS keychain)";
  if (s.elevenlabs_voice) {
    const sel = $("eleven-voice");
    sel.innerHTML = "";
    const o = document.createElement("option");
    o.value = s.elevenlabs_voice;
    o.textContent = s.elevenlabs_voice_name || s.elevenlabs_voice;
    sel.appendChild(o);
  }
  renderKokoro();
  renderHookStatus();
  renderVoices();
}

// --- kokoro -----------------------------------------------------------------

function renderKokoro() {
  const have = info.kokoro;
  $("kokoro-fetch").hidden = have;
  $("kokoro-remove").hidden = !have;
  $("kokoro-note").textContent = have
    ? "Local, better voice. Installed."
    : "Local, better voice. Download 320 MB into your models folder.";
  const d = info.downloading;
  $("kokoro-progress").hidden = !d;
  if (d) {
    $("kokoro-progress").value = Math.round((100 * d.received) / Math.max(1, d.total));
    note(
      "kokoro-status",
      d.phase === "unpack"
        ? "unpacking…"
        : `${Math.round(d.received / 1e6)} / ${Math.round(d.total / 1e6)} MB`,
    );
  }
}

$("kokoro-fetch").addEventListener("click", async (e) => {
  e.preventDefault();
  $("kokoro-fetch").disabled = true;
  $("kokoro-progress").hidden = false;
  note("kokoro-status", "starting…");
  const r = await api.fetchKokoro();
  $("kokoro-fetch").disabled = false;
  info = await api.get();
  renderKokoro();
  note("kokoro-status", r.error ? r.error : "installed", r.error ? "bad" : "good");
});

$("kokoro-remove").addEventListener("click", async (e) => {
  e.preventDefault();
  await api.removeKokoro();
  info = await api.get();
  renderKokoro();
  note("kokoro-status", "removed");
});

api.onProgress((p) => {
  if (!info) return;
  info.downloading = p;
  renderKokoro();
});

// --- hooks ------------------------------------------------------------------

function renderHookStatus() {
  const h = info.hooks;
  if (h.installed.length) {
    note(
      "hook-status",
      `Connected: ${h.installed.length} events via ${h.kind}${h.assets.length ? ", output style and speak skill installed" : ""}.`,
      "good",
    );
  } else {
    note(
      "hook-status",
      info.curl
        ? "Not connected. The hook will be curl, about ten milliseconds per call."
        : "Not connected. No curl found; the Node hook will be used.",
    );
  }
  const legacy = h.legacy.length || h.legacyAssets.length;
  $("legacy").hidden = !legacy;
  if (legacy) {
    $("legacy-text").textContent =
      `${h.legacy.length} hook events${h.legacyAssets.length ? ` and ${h.legacyAssets.length} files` : ""} from the old ClaudeTalks are still in your Claude Code settings, pointing at a daemon that isn't running.`;
  }
}

async function previewHooks() {
  const profile = document.querySelector("input[name=profile]:checked")?.value ?? "balanced";
  const r = await api.previewHooks(profile);
  if (r.error) {
    $("hook-preview-body").textContent = r.error;
    return;
  }
  $("hook-preview-body").textContent =
    `${r.file}\n\n${r.events.map((e) => `${e}: ${r.command}`).join("\n")}\n\n~/.claude/output-styles/kikoe.md\n~/.claude/skills/speak/SKILL.md`;
}

for (const r of document.querySelectorAll("input[name=profile]"))
  r.addEventListener("change", previewHooks);

$("hooks-install").addEventListener("click", async () => {
  const profile = document.querySelector("input[name=profile]:checked")?.value ?? "balanced";
  note("hooks-note", "writing…");
  const r = await api.installHooks(profile);
  if (r.error) return note("hooks-note", r.error, "bad");
  info = await api.get();
  renderHookStatus();
  note(
    "hooks-note",
    `Added ${r.events.length} hooks${r.backup ? ", backup kept beside the file" : ""}${r.assets.length ? `, ${r.assets.length} files` : ""}. Restart Claude Code sessions to pick them up.`,
    "good",
  );
});

$("hooks-uninstall").addEventListener("click", async () => {
  const r = await api.uninstallHooks();
  if (r.error) return note("hooks-note", r.error, "bad");
  info = await api.get();
  renderHookStatus();
  note(
    "hooks-note",
    r.removed.length ? `Removed from ${r.removed.length} events.` : "Nothing of ours was there.",
    "good",
  );
});

$("migrate").addEventListener("click", async () => {
  note("migrate-note", "removing…");
  const r = await api.migrate();
  if (r.error) return note("migrate-note", r.error, "bad");
  info = await api.get();
  renderHookStatus();
  note(
    "migrate-note",
    `Removed ${r.legacyRemoved.length} hook events and ${r.assets.length} files. Backup kept beside the file.`,
    "good",
  );
});

$("pick-claude").addEventListener("click", async () => {
  const r = await api.pickClaudeSettings();
  if (r.ok) {
    info = await api.get();
    $("claude-path").textContent = r.file;
    renderHookStatus();
    previewHooks();
  }
});

// --- voice ------------------------------------------------------------------

for (const b of document.querySelectorAll("button.play")) {
  b.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const tts = b.dataset.tts;
    const patch = { tts };
    if (tts === "eleven") {
      const key = $("eleven-key").value.trim();
      const voice = $("eleven-voice").value;
      if (key) patch.elevenKey = key;
      if (!voice && !info.settings.elevenlabs_voice)
        return note("voice-note", "Pick an ElevenLabs voice first.", "bad");
      if (voice) {
        patch.elevenlabs_voice = voice;
        patch.elevenlabs_voice_name = $("eleven-voice").selectedOptions[0]?.textContent ?? voice;
      }
    }
    if (tts === "kokoro" && !info.kokoro)
      return note("voice-note", "Download Kokoro first.", "bad");
    b.disabled = true;
    note("voice-note", "switching…");
    const r = await api.save(patch);
    if (r.error) note("voice-note", r.error, "bad");
    else {
      note("voice-note", "");
      await api.say(LINES[tts]);
    }
    b.disabled = false;
    document.querySelector(`input[name=tts][value=${tts}]`).checked = true;
  });
}

$("eleven-refresh").addEventListener("click", async (e) => {
  e.preventDefault();
  const key = $("eleven-key").value.trim();
  if (key) await api.save({ elevenKey: key });
  note("voice-note", "loading voices…");
  const r = await api.elevenVoices();
  if (r.error) return note("voice-note", r.error, "bad");
  const sel = $("eleven-voice");
  sel.innerHTML = '<option value="">— pick a voice —</option>';
  for (const v of r.voices) {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = `${v.name}${v.gender ? ` · ${v.gender}` : ""}${v.accent ? ` · ${v.accent}` : ""}`;
    sel.appendChild(o);
  }
  if (info.settings.elevenlabs_voice) sel.value = info.settings.elevenlabs_voice;
  info.elevenVoices = r.voices;
  fillVoicePick();
  note("voice-note", `${r.voices.length} voices`, "good");
});

$("voice-save").addEventListener("click", async () => {
  const tts = document.querySelector("input[name=tts]:checked")?.value ?? "piper";
  const patch = { tts, tts_strict: $("strict").checked };
  if (tts === "eleven") {
    const key = $("eleven-key").value.trim();
    if (key) patch.elevenKey = key;
    const voice = $("eleven-voice").value;
    if (voice) {
      patch.elevenlabs_voice = voice;
      patch.elevenlabs_voice_name = $("eleven-voice").selectedOptions[0]?.textContent ?? voice;
    }
  }
  note("voice-note", "saving…");
  const r = await api.save(patch);
  if (r.error) return note("voice-note", r.error, "bad");
  info.settings = r.settings;
  note("voice-note", "saved", "good");
});

// --- a voice per repo --------------------------------------------------------

function fillVoicePick() {
  const sel = $("voice-pick");
  sel.innerHTML = "";
  const add = (value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  add("piper:", "Piper");
  if (info.kokoro) for (let i = 0; i < 11; i++) add(`kokoro:${i}`, `Kokoro speaker ${i}`);
  for (const v of info.elevenVoices ?? []) add(`eleven:${v.id}`, `ElevenLabs · ${v.name}`);
  if (info.settings.elevenlabs_voice && !(info.elevenVoices ?? []).length) {
    add(
      `eleven:${info.settings.elevenlabs_voice}`,
      `ElevenLabs · ${info.settings.elevenlabs_voice_name || "current"}`,
    );
  }
}

function renderVoices() {
  fillVoicePick();
  const body = $("voices-table").querySelector("tbody");
  body.innerHTML = "";
  for (const [repo, v] of Object.entries(info.settings.voices ?? {})) {
    const tr = document.createElement("tr");
    const name =
      v.backend === "eleven"
        ? ((info.elevenVoices ?? []).find((x) => x.id === v.voice)?.name ?? v.voice)
        : v.backend === "kokoro"
          ? `speaker ${v.voice ?? 0}`
          : "";
    const tdRepo = document.createElement("td");
    tdRepo.textContent = repo;
    const tdVoice = document.createElement("td");
    tdVoice.textContent = `${v.backend ?? ""} ${name ?? ""}`;
    const tdActions = document.createElement("td");
    const play = document.createElement("button");
    play.className = "quiet small";
    play.textContent = "▶";
    play.addEventListener("click", () => api.say(`In ${repo}, tests pass.`, repo));
    const del = document.createElement("button");
    del.className = "quiet small";
    del.textContent = "remove";
    del.addEventListener("click", async () => {
      const voices = { ...info.settings.voices };
      delete voices[repo];
      const r = await api.save({ voices });
      info.settings = r.settings;
      renderVoices();
    });
    tdActions.append(play, " ", del);
    tr.append(tdRepo, tdVoice, tdActions);
    body.appendChild(tr);
  }
}

$("voice-add").addEventListener("click", async () => {
  const repo = $("voice-repo").value.trim();
  const [backend, voice] = ($("voice-pick").value || "piper:").split(":");
  if (!repo) return;
  const voices = {
    ...(info.settings.voices ?? {}),
    [repo]: voice ? { backend, voice } : { backend },
  };
  const r = await api.save({ voices });
  info.settings = r.settings;
  $("voice-repo").value = "";
  renderVoices();
});

// --- narration --------------------------------------------------------------

$("narrate-save").addEventListener("click", async () => {
  const narrate = document.querySelector("input[name=narrate]:checked")?.value ?? "normal";
  const earcons = document.querySelector("input[name=earcons]:checked")?.value ?? "cues";
  const r = await api.save({ narrate, earcons });
  note("narrate-note", r.error ? r.error : "saved", r.error ? "bad" : "good");
});

// --- sessions ---------------------------------------------------------------

function ago(s) {
  if (!s) return "";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function sessionRow(s) {
  const d = document.createElement("div");
  d.className = "row session";
  d.dataset.status = s.status;
  const bits = [];
  if (s.status === "working" && s.current_tool) bits.push(`doing ${s.current_tool}`);
  if (s.running_for_s) bits.push(`for ${ago(s.running_for_s)}`);
  if (s.status === "waiting" && s.pending_permission) bits.push(`waiting: ${s.pending_permission}`);
  if (s.last_test_result) bits.push(`tests ${s.last_test_result}`);
  if (s.last_error) bits.push(`error: ${s.last_error.slice(0, 80)}`);
  const dot = document.createElement("span");
  dot.className = "dot";
  const body = document.createElement("div");
  const title = document.createElement("b");
  title.textContent = s.label;
  const meta = document.createElement("span");
  meta.className = "dim";
  meta.textContent = ` ${s.status} · ${s.turns} turns · quiet ${ago(s.quiet_for_s)}`;
  const detail = document.createElement("span");
  detail.textContent = bits.join(" · ");
  body.append(title, meta, document.createElement("br"), detail);
  d.append(dot, body);
  return d;
}

async function renderSessions() {
  info = await api.get();
  const st = info.state;
  const list = $("sessions-list");
  list.innerHTML = "";
  const pend = st?.pending_permission;
  $("pending").hidden = !pend;
  if (pend) $("pending-text").textContent = `${pend.repo}: ${pend.text}`;
  const rows = Object.values(st?.sessions ?? {});
  if (!rows.length) {
    const d = document.createElement("div");
    d.className = "dim";
    d.textContent = "No sessions yet. Start a Claude Code session and give it a task.";
    list.appendChild(d);
  }
  const rank = (s) => (s.status === "waiting" ? 0 : s.status === "working" ? 1 : 2);
  for (const s of rows.sort((a, b) => rank(a) - rank(b))) list.appendChild(sessionRow(s));
  const h = $("history");
  h.innerHTML = "";
  for (const rec of st?.history ?? []) {
    const d = document.createElement("div");
    d.className = "line";
    const t = new Date(rec.ts * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const when = document.createElement("span");
    when.className = "dim";
    when.textContent = `${t} `;
    const who = document.createElement("b");
    who.textContent = rec.label ? `${rec.label} ` : "";
    const text = document.createTextNode(rec.text);
    const how = document.createElement("span");
    how.className = "dim";
    how.textContent = ` ${rec.backend}${rec.latency_ms !== null ? ` · ${rec.latency_ms} ms` : ""}`;
    d.append(when, who, text, how);
    h.appendChild(d);
  }
}

$("perm-allow").addEventListener("click", () => api.answerPermission(true));
$("perm-deny").addEventListener("click", () => api.answerPermission(false));
$("stop-talking").addEventListener("click", () => api.interrupt());

// --- hear it ----------------------------------------------------------------

$("demo").addEventListener("click", async () => {
  note("demo-note", "playing… watch the pill");
  await api.demo();
  setTimeout(() => note("demo-note", ""), 16000);
});

$("finish").addEventListener("click", async () => {
  await api.save({ onboarded: true });
  window.close();
});

// --- general ----------------------------------------------------------------

$("login").addEventListener("change", () => api.save({ start_at_login: $("login").checked }));
for (const r of document.querySelectorAll("input[name=theme]"))
  r.addEventListener("change", () => api.save({ theme: r.value }));
$("mic-save").addEventListener("click", async () => {
  note("mic-note", "saving…");
  const device = $("mic-device").value;
  const r = await api.save({
    mic: $("mic").checked,
    mic_device: device ? device.split(" (")[0].slice(0, 24) : "",
    wake_name: $("wake").value.trim() || "kikoe",
  });
  note(
    "mic-note",
    r.error ? r.error : $("mic").checked ? "listening" : "off",
    r.error ? "bad" : "good",
  );
});
$("open-logs").addEventListener("click", () => api.openLogs());
$("open-home").addEventListener("click", () => api.openHome());

// --- doctor -----------------------------------------------------------------

async function renderDoctor() {
  info = await api.get();
  const st = info.state;
  const lines = [];
  const ok = (b, good, bad) => lines.push(`${b ? "✓" : "✗"} ${b ? good : bad}`);
  ok(
    Boolean(st),
    `daemon answering on port ${info.settings.port}, up ${ago(st?.uptime_s ?? 0)}${info.restarts ? `, restarted ${info.restarts}×` : ""}`,
    "daemon not running",
  );
  if (st) {
    ok(
      st.tts.ladder.length > 0,
      `voices: ${st.tts.ladder.join(" > ")}${st.tts.last ? ` (last used ${st.tts.last})` : ""}${st.tts.strict ? ", strict" : ""}${st.tts.loaded?.length ? `; loaded: ${st.tts.loaded.join(", ")}` : ""}`,
      "no TTS backend available",
    );
    ok(
      st.speaker.device !== "none",
      `speaker: ${st.speaker.device} @ ${st.speaker.rate} Hz`,
      "no audio device: playing nothing",
    );
    lines.push(
      `  mode: ${st.mode}${info.paused ? " (paused)" : ""}; cues: ${info.settings.earcons}; spoken ${st.arbiter.spoken}, dropped ${st.arbiter.dropped}, queued ${st.arbiter.queued}`,
    );
    lines.push(
      `  events seen: ${st.events_seen}; sessions: ${Object.keys(st.sessions).length}; island subscribers: ${st.hub_subscribers}`,
    );
    const l = st.latency;
    if (l?.n)
      lines.push(
        `  latency, event to first sound: p50 ${l.p50} ms, p90 ${l.p90} ms over ${l.n} lines; first audio p50 ${l.ttfa_p50} ms`,
      );
    else lines.push("  latency: no measured lines yet");
  }
  ok(
    info.hooks.installed.length > 0,
    `hooks: ${info.hooks.installed.length} events via ${info.hooks.kind} in ${info.hooks.file}`,
    `hooks not installed in ${info.hooks.file}`,
  );
  ok(
    info.hooks.assets.length === 2,
    "output style and speak skill installed",
    "output style or speak skill missing (connect Claude Code again)",
  );
  if (info.hooks.legacy.length)
    lines.push(
      `! ${info.hooks.legacy.length} old ClaudeTalks hook events still present; remove them on the Claude Code page`,
    );
  ok(
    info.curl,
    "curl found: the hook costs about ten milliseconds",
    "no curl: the Node hook is used instead",
  );
  ok(info.hasElevenKey, "ElevenLabs key in the keychain", "no ElevenLabs key (optional)");
  ok(info.kokoro, "Kokoro installed", "Kokoro not downloaded (optional)");
  if (st?.mic) {
    const m = st.mic;
    ok(
      m.enabled && m.phase.startsWith("listening"),
      `microphone: ${m.phase}${m.device ? ` on ${m.device}` : ""}`,
      m.enabled ? `microphone: ${m.phase}` : "microphone off (turn it on under General)",
    );
  }
  if (info.lastCrash) lines.push(`! last crash: ${info.lastCrash}`);
  lines.push(`  data: ${info.home}`);
  lines.push(`  platform: ${info.platform}, kikoe ${info.version}`);
  if (st && st.events_seen === 0 && info.hooks.installed.length)
    lines.push(
      "\nNo events yet. Start a Claude Code session and give it a task; the first hook call lands here.",
    );
  $("doctor").textContent = lines.join("\n");
}

$("doctor-refresh").addEventListener("click", renderDoctor);

// --- navigation -------------------------------------------------------------

for (const b of document.querySelectorAll("[data-page]"))
  b.addEventListener("click", () => show(b.dataset.page));
for (const b of document.querySelectorAll("[data-go]"))
  b.addEventListener("click", () => show(b.dataset.go));
api.onGoto((page) => {
  if (page === "welcome") {
    onboarding = true;
    document.body.classList.add("onboarding");
  }
  show(page);
});

load().then(() => {
  const hash = location.hash.replace(/^#/, "");
  if (hash === "welcome") {
    onboarding = true;
    document.body.classList.add("onboarding");
  }
  show(hash || "sessions");
});
