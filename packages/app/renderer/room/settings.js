// Settings, as a view inside the Kikoe window. Everything talks to the main
// process through the named calls the preload exposes as window.kikoe.
// Exposes window.settingsPanel = { open(page), close() }.

(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.kikoe;
  if (!api) {
    // The browser-served Room has no settings; the view stays hidden.
    window.settingsPanel = { open() {}, close() {} };
    return;
  }
  let info = null;

  const LINES = {
    piper: "Tests pass. Eighteen passed, two failed, all Windows path stuff.",
    kokoro: "Race is fixed. Three tests still failing.",
    eleven: "It wants to push. Shall I?",
    system: "Done. Fixed the race in token refresh.",
  };

  function note(id, text, tone = "") {
    const el = $(id);
    if (!el) return;
    el.textContent = text || "";
    el.dataset.tone = tone;
  }

  function showPage(page) {
    for (const s of document.querySelectorAll(".spage")) s.hidden = s.id !== `spage-${page}`;
    for (const b of document.querySelectorAll("#snav button[data-spage]")) {
      if (b.dataset.spage === page) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
    if (page === "doctor") renderDoctor();
    if (page === "hooks") previewHooks();
    if (page === "usage") renderUsage();
  }

  // --- limits ---------------------------------------------------------------
  //
  // One row per provider, saying what was read, from whose credential, and
  // when. A row that is off is not read at all — the switch is about the
  // credential, not about the ring.

  function renderUsage() {
    const rows = $("usage-rows");
    if (!rows) return;
    $("usage-on").checked = info.settings.usage !== false;
    const off = new Set(info.settings.usage_off || []);
    const providers = info.state?.usage || [];
    rows.textContent = "";
    if (!providers.length && !off.size) {
      const empty = document.createElement("p");
      empty.className = "dim";
      empty.textContent =
        "Nothing to read yet. Sign in to Claude Code — or any tool Kikoe knows — and its ring appears on its own.";
      rows.append(empty);
      return;
    }
    for (const p of providers) rows.append(usageRow(p, off.has(p.id)));
  }

  function usageRow(p, isOff) {
    const label = document.createElement("label");
    label.className = "row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !isOff;
    box.addEventListener("change", async () => {
      const off = new Set(info.settings.usage_off || []);
      if (box.checked) off.delete(p.id);
      else off.add(p.id);
      const r = await api.save({ usage_off: [...off] });
      info = await api.get();
      note(
        "usage-note",
        r.error || (box.checked ? `reading ${p.name}` : `${p.name} left alone`),
        r.error ? "bad" : "good",
      );
      renderUsage();
    });

    const text = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = p.plan ? `${p.name} — ${p.plan}` : p.name;
    const detail = document.createElement("span");
    // The reading itself, then where it came from. A status where a number
    // should be always says what to do about it.
    const windows = (p.windows || [])
      .map((w) => `${w.label} ${Math.round(w.used * 100)}%`)
      .join(" · ");
    detail.textContent = [
      windows || p.message || "nothing read",
      `borrowed from ${p.source}`,
      p.status === "ok" ? "" : p.status.replace(/_/g, " "),
    ]
      .filter(Boolean)
      .join(" — ");
    text.append(title, detail);
    label.append(box, text);
    return label;
  }

  async function load() {
    info = await api.get();
    $("version").textContent = info.version;
    const s = info.settings;
    const tts =
      s.tts === "auto" ? (info.hasElevenKey && s.elevenlabs_voice ? "eleven" : "piper") : s.tts;
    const pick = (name, value) => {
      const r = document.querySelector(`input[name=${name}][value=${value}]`);
      if (r) r.checked = true;
    };
    pick("tts", tts);
    pick("narrate", s.narrate);
    pick("earcons", s.earcons || "cues");
    pick("profile", s.hook_profile);
    pick("theme", s.theme || "system");
    pick("backdrop", s.backdrop || "grid");
    $("backdrop-dim").value = String(s.backdrop_dim ?? 0.35);
    $("backdrop-blur").checked = s.backdrop_blur !== false;
    if (s.backdrop_image)
      $("swatch-custom").style.backgroundImage =
        `url(file:///${s.backdrop_image.replace(/\\/g, "/")})`;
    $("strict").checked = Boolean(s.tts_strict);
    $("login").checked = Boolean(info.loginItem);
    $("mic").checked = Boolean(s.mic);
    $("wake").value = s.wake_name || "kikoe";
    $("stt-model").value = s.stt_model || "tiny";
    $("hear-debug").checked = Boolean(s.hear_debug);
    $("hear-you").checked = s.hear_you !== false;
    $("barge-in").checked = Boolean(s.barge_in);
    $("brain").checked = Boolean(s.brain);
    $("brain-model").value = s.brain_model || "claude-haiku-4-5-20251001";
    $("brain-provider").value = s.brain_provider || "anthropic";
    $("brain-narrates").checked = s.brain_narrates !== false;
    $("brain-checkin").checked = s.brain_checkin !== false;
    $("brain-greets").checked = s.brain_greets !== false;
    $("artifact-model").value = s.artifact_model || "claude-sonnet-5";
    $("anthropic-key").placeholder = info.hasAnthropicKey
      ? "key saved in the keychain (paste to replace)"
      : "Anthropic API key (stored in the OS keychain)";
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
      if (s.mic_device) {
        const hit = [...sel.options].find((o) =>
          o.value.toLowerCase().includes(s.mic_device.toLowerCase()),
        );
        sel.value = hit?.value ?? "";
      }
    });
    renderKokoro();
    renderHookStatus();
    renderVoices();
  }

  // --- kokoro ---------------------------------------------------------------

  function renderKokoro() {
    const have = info.kokoro;
    $("kokoro-fetch").hidden = have;
    $("kokoro-remove").hidden = !have;
    $("kokoro-note").textContent = have
      ? "Local, a better voice, about four hundred milliseconds. Installed."
      : "Local, a better voice, about four hundred milliseconds. Download 320 MB.";
    const d = info.downloading;
    $("kokoro-progress").hidden = !d;
    if (d) {
      $("kokoro-progress").value = Math.round((100 * d.received) / Math.max(1, d.total));
      note(
        "kokoro-status",
        d.phase === "unpack"
          ? "unpacking…"
          : `${d.name}: ${Math.round(d.received / 1e6)} / ${Math.round(d.total / 1e6)} MB`,
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
    if (p?.name?.startsWith("whisper"))
      note(
        "mic-note",
        `${p.name}: ${Math.round(p.received / 1e6)} / ${Math.round(p.total / 1e6)} MB`,
      );
    if (!p) note("mic-note", "");
  });

  // --- hooks ----------------------------------------------------------------

  function renderHookStatus() {
    const h = info.hooks;
    if (h.installed.length) {
      note(
        "hook-status",
        `Connected: ${h.installed.length} events via ${h.kind}${h.assets.length ? ", output style and skill installed" : ""}.`,
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
    if (legacy)
      $("legacy-text").textContent =
        `${h.legacy.length} hook events${h.legacyAssets.length ? ` and ${h.legacyAssets.length} files` : ""} from the old ClaudeTalks are still in your Claude Code settings, pointing at a daemon that isn't running.`;
  }

  async function previewHooks() {
    const profile = document.querySelector("input[name=profile]:checked")?.value ?? "balanced";
    const r = await api.previewHooks(profile);
    $("hook-preview-body").textContent = r.error
      ? r.error
      : `${r.file}\n\n${r.events.map((e) => `${e}: ${r.command}`).join("\n")}\n\n~/.claude/output-styles/kikoe.md\n~/.claude/skills/speak/SKILL.md`;
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
      `Added ${r.events.length} hooks${r.backup ? ", backup kept beside the file" : ""}. Restart Claude Code sessions to pick them up.`,
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
  $("demo").addEventListener("click", async () => {
    note("demo-note", "playing… back to the room to watch the board");
    await api.demo();
    setTimeout(() => note("demo-note", ""), 16000);
  });

  // --- voice ----------------------------------------------------------------

  for (const b of document.querySelectorAll("#settingsview button.play")) {
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
    if (info.settings.elevenlabs_voice && !(info.elevenVoices ?? []).length)
      add(
        `eleven:${info.settings.elevenlabs_voice}`,
        `ElevenLabs · ${info.settings.elevenlabs_voice_name || "current"}`,
      );
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

  // --- listening, narration, look, screens, board ---------------------------

  $("mic-save").addEventListener("click", async () => {
    note("mic-note", "saving…");
    const device = $("mic-device").value;
    const r = await api.save({
      mic: $("mic").checked,
      mic_device: device ? device.split(" (")[0].slice(0, 24) : "",
      wake_name: $("wake").value.trim() || "kikoe",
      stt_model: $("stt-model").value,
      hear_debug: $("hear-debug").checked,
      hear_you: $("hear-you").checked,
      barge_in: $("barge-in").checked,
    });
    note(
      "mic-note",
      r.error ? r.error : $("mic").checked ? "listening" : "off",
      r.error ? "bad" : "good",
    );
  });
  $("brain-save").addEventListener("click", async () => {
    const key = $("anthropic-key").value.trim();
    const patch = {
      brain: $("brain").checked,
      brain_model: $("brain-model").value,
      brain_provider: $("brain-provider").value,
      brain_narrates: $("brain-narrates").checked,
      brain_checkin: $("brain-checkin").checked,
      brain_greets: $("brain-greets").checked,
      artifact_model: $("artifact-model").value,
    };
    if (key) patch.anthropicKey = key;
    const viaOpenrouter = patch.brain_provider === "openrouter";
    if (patch.brain && viaOpenrouter && !info.hasOpenrouterKey)
      return note("brain-note", "Put an OpenRouter key in openrouter_key.txt first.", "bad");
    if (patch.brain && !viaOpenrouter && !key && !info.hasAnthropicKey)
      return note("brain-note", "Paste an Anthropic API key first.", "bad");
    note("brain-note", "saving…");
    const r = await api.save(patch);
    if (r.error) return note("brain-note", r.error, "bad");
    info = await api.get();
    $("anthropic-key").value = "";
    $("anthropic-key").placeholder = info.hasAnthropicKey
      ? "key saved in the keychain (paste to replace)"
      : "Anthropic API key";
    note(
      "brain-note",
      patch.brain ? "on: say “kik, what do you think?”" : "off: the rulebook answers",
      "good",
    );
  });
  $("narrate-save").addEventListener("click", async () => {
    const narrate = document.querySelector("input[name=narrate]:checked")?.value ?? "normal";
    const earcons = document.querySelector("input[name=earcons]:checked")?.value ?? "cues";
    const r = await api.save({ narrate, earcons });
    note("narrate-note", r.error ? r.error : "saved", r.error ? "bad" : "good");
  });
  for (const r of document.querySelectorAll("input[name=backdrop]"))
    r.addEventListener("change", async () => {
      if (r.value === "custom" && !info.settings.backdrop_image) {
        const p = await api.pickBackdrop();
        if (!p.ok) return pick("backdrop", info.settings.backdrop || "grid");
        info = await api.get();
        $("swatch-custom").style.backgroundImage = `url(file:///${p.file.replace(/\\/g, "/")})`;
        return note("backdrop-note", "your image", "good");
      }
      const res = await api.save({ backdrop: r.value });
      note("backdrop-note", res.error ? res.error : r.value, res.error ? "bad" : "good");
    });
  $("pick-backdrop").addEventListener("click", async () => {
    const p = await api.pickBackdrop();
    if (!p.ok) return;
    info = await api.get();
    pick("backdrop", "custom");
    $("swatch-custom").style.backgroundImage = `url(file:///${p.file.replace(/\\/g, "/")})`;
    note("backdrop-note", "your image", "good");
  });
  $("backdrop-dim").addEventListener("change", () =>
    api.save({ backdrop_dim: Number($("backdrop-dim").value) }),
  );
  $("backdrop-blur").addEventListener("change", () =>
    api.save({ backdrop_blur: $("backdrop-blur").checked }),
  );
  for (const r of document.querySelectorAll("input[name=theme]"))
    r.addEventListener("change", () => api.save({ theme: r.value }));
  $("login").addEventListener("change", () => api.save({ start_at_login: $("login").checked }));
  $("open-logs").addEventListener("click", () => api.openLogs());
  $("open-home").addEventListener("click", () => api.openHome());
  $("board-clear").addEventListener("click", () => window.room.clearBoard());
  $("copy-viewer").addEventListener("click", async () => {
    const r = await api.copyLink("viewer");
    note(
      "screens-note",
      r.ok ? "Viewer link copied. Open it on the other screen." : r.error,
      r.ok ? "good" : "bad",
    );
  });
  $("copy-full").addEventListener("click", async () => {
    const r = await api.copyLink("full");
    note(
      "screens-note",
      r.ok ? "Copied. Anyone holding this link can answer a permission." : r.error,
      r.ok ? "bad" : "bad",
    );
  });

  // --- doctor ---------------------------------------------------------------

  function ago(s) {
    if (!s) return "0s";
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }
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
        `  events seen: ${st.events_seen}; sessions: ${Object.keys(st.sessions).length}; pins: ${(st.pins ?? []).length}; stream subscribers: ${st.hub_subscribers}`,
      );
      const l = st.latency;
      lines.push(
        l?.n
          ? `  latency, event to first sound: p50 ${l.p50} ms, p90 ${l.p90} ms over ${l.n} lines; first audio p50 ${l.ttfa_p50} ms`
          : "  latency: no measured lines yet",
      );
      const m = st.mic;
      ok(
        m.enabled && String(m.phase).startsWith("listening"),
        `microphone: ${m.phase}${m.device ? ` on ${m.device}` : ""}, model ${info.settings.stt_model}`,
        m.enabled ? `microphone: ${m.phase}` : "microphone off (Listening page)",
      );
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
    lines.push(
      "  second screen: viewer link on the Screens page; the daemon listens on 127.0.0.1 only",
    );
    if (info.lastCrash) lines.push(`! last crash: ${info.lastCrash}`);
    lines.push(`  data: ${info.home}`);
    lines.push(`  platform: ${info.platform}, kikoe ${info.version}`);
    $("doctor").textContent = lines.join("\n");
  }
  $("doctor-refresh").addEventListener("click", renderDoctor);

  $("usage-on").addEventListener("change", async () => {
    const r = await api.save({ usage: $("usage-on").checked });
    info = await api.get();
    note("usage-note", r.error || (r.settings.usage ? "on" : "off"), r.error ? "bad" : "good");
    renderUsage();
  });
  $("usage-refresh").addEventListener("click", async () => {
    note("usage-note", "reading…");
    const r = await api.refreshUsage();
    info = await api.get();
    renderUsage();
    note("usage-note", r?.error || "read just now", r?.error ? "bad" : "good");
  });

  // --- navigation -------------------------------------------------------------

  for (const b of document.querySelectorAll("#snav button[data-spage]"))
    b.addEventListener("click", () => showPage(b.dataset.spage));
  for (const b of document.querySelectorAll("[data-sgo]"))
    b.addEventListener("click", () => showPage(b.dataset.sgo));
  $("settings-back").addEventListener("click", () => window.settingsPanel.close());

  let loaded = false;
  window.settingsPanel = {
    async open(page) {
      if (!loaded) {
        await load();
        loaded = true;
      } else info = await api.get();
      $("settingsview").hidden = false;
      document.body.dataset.view = "settings";
      showPage(page || (info.settings.onboarded ? "voice" : "welcome"));
    },
    close() {
      $("settingsview").hidden = true;
      document.body.dataset.view = "room";
      if (info && !info.settings.onboarded) api.save({ onboarded: true });
    },
  };
})();
