// The Room on a phone: the same canvas as the desk, with a button to talk.
//
// Only on a page the walkie served (`?phone=1`); inside the app and on a
// second screen this does nothing. What you say goes to the walkie's /audio,
// which transcribes it with the desk's Whisper and hands it to Kik as though
// the headset had heard it — so the answer is spoken from the desk and lands
// on this canvas like everything else. Nothing here decides anything.

(() => {
  if (new URLSearchParams(location.search).get("phone") !== "1") return;
  const RATE = 16000;

  const wrap = document.createElement("div");
  wrap.className = "phone-talk";
  wrap.innerHTML =
    '<div class="phone-said" id="phone-said"></div>' +
    '<div class="phone-row">' +
    '<button type="button" id="phone-sound" aria-pressed="false" title="hear Kik on this phone">sound<br>off</button>' +
    '<button type="button" id="phone-talk" aria-label="hold to talk to Kik">hold to talk</button>' +
    '<canvas id="phone-orb" class="phone-orb" aria-label="what Kik is doing"></canvas>' +
    "</div>";
  document.body.appendChild(wrap);
  const talk = wrap.querySelector("#phone-talk");
  // Kik's state at a glance, as a thought-orb: the Room's setOrb tells it,
  // and holding the button is listening, whatever the desk says.
  const orb = window.KikOrb?.create(wrap.querySelector("#phone-orb"), { size: 64, dark: true });
  let deskVerb = "breathing";
  window.addEventListener("kik-orb", (e) => {
    deskVerb = e.detail;
    if (!recording) orb?.set(deskVerb);
  });
  const said = wrap.querySelector("#phone-said");
  const sound = wrap.querySelector("#phone-sound");

  // --- hearing Kik here ------------------------------------------------------
  // The desk speaker's audio, as it plays, from the walkie's /voice stream.
  // Each piece is scheduled right after the last so the line plays through
  // without gaps; a drop (Kik cut off at the desk) stops it here too.
  let out = null;
  let voice = null;
  let next = 0;
  const playing = new Set();
  const KEY = "kikoe-phone-sound";

  function play(rate, b64) {
    if (!out) return;
    const bin = atob(b64);
    const n = bin.length >> 1;
    const buf = out.createBuffer(1, n, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      ch[i] = v / 0x8000;
    }
    const src = out.createBufferSource();
    src.buffer = buf;
    src.connect(out.destination);
    const at = Math.max(out.currentTime + 0.05, next);
    src.start(at);
    next = at + buf.duration;
    playing.add(src);
    src.onended = () => playing.delete(src);
  }

  function hush() {
    for (const s of playing) {
      try {
        s.stop();
      } catch {
        /* already done */
      }
    }
    playing.clear();
    next = 0;
  }

  function setSound(on) {
    sound.setAttribute("aria-pressed", on ? "true" : "false");
    sound.innerHTML = on ? "sound<br>on" : "sound<br>off";
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* a private tab forgets, which is fine */
    }
    if (!on) {
      voice?.close();
      voice = null;
      hush();
      return;
    }
    // Made inside the tap: a phone will not play audio a page started on its own.
    out = out || new (window.AudioContext || window.webkitAudioContext)();
    if (out.state === "suspended") out.resume();
    if (voice) return;
    voice = new EventSource("/voice");
    voice.addEventListener("pcm", (e) => {
      try {
        const j = JSON.parse(e.data);
        play(j.r, j.b);
      } catch {
        /* a torn event is one lost syllable */
      }
    });
    voice.addEventListener("drop", hush);
  }

  sound.addEventListener("click", () => setSound(sound.getAttribute("aria-pressed") !== "true"));
  let wanted = false;
  try {
    wanted = localStorage.getItem(KEY) === "1";
  } catch {
    /* no storage, no memory of the choice */
  }
  // Remembered as on: listen now, and let the first tap anywhere unlock the audio.
  if (wanted) {
    setSound(true);
    const unlock = () => out?.state === "suspended" && out.resume();
    window.addEventListener("pointerdown", unlock, { once: true });
  }

  let ctx = null;
  let chunks = [];
  let recording = false;
  /** the last moment before the press, kept while not recording */
  let before = [];
  const PRE_ROLL_S = 0.4;
  /** how long recording runs on after the finger lifts */
  const TAIL_MS = 450;
  let tail = null;
  /** when the button went down, and how long it was held */
  let pressedAt = 0;
  let held = 0;
  let clear = null;

  function show(text, ms = 4000) {
    said.textContent = text;
    said.dataset.on = text ? "1" : "0";
    if (clear) clearTimeout(clear);
    if (text && ms) clear = setTimeout(() => show(""), ms);
  }

  // The phone records at 44.1 or 48 kHz; Whisper wants 16. Averaging each run
  // of samples is cheaper than a filter and good enough for speech.
  function downsample(input, from, to) {
    if (from === to) return Float32Array.from(input);
    const ratio = from / to;
    const out = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = a; j < b; j++) sum += input[j];
      out[i] = b > a ? sum / (b - a) : 0;
    }
    return out;
  }

  async function open() {
    if (ctx) return true;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      show("this browser will not share the microphone here; open /cert.pem and trust it", 0);
      return false;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      show(`microphone refused: ${e?.name || e}`, 0);
      return false;
    }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    // A ScriptProcessor, not a worklet: a worklet needs its own module URL,
    // and this page must load everything from the one origin it trusts.
    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => {
      const piece = downsample(e.inputBuffer.getChannelData(0), ctx.sampleRate, RATE);
      if (recording) {
        chunks.push(piece);
        return;
      }
      // Not recording: keep the last moment anyway, so a word begun as the
      // finger lands is not missing its first syllable.
      before.push(piece);
      let kept = 0;
      for (const c of before) kept += c.length;
      while (before.length > 1 && kept - before[0].length > RATE * PRE_ROLL_S) {
        kept -= before[0].length;
        before.shift();
      }
    };
    src.connect(node);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);
    return true;
  }

  function start(e) {
    e?.preventDefault();
    if (!ctx || recording) return;
    if (ctx.state === "suspended") ctx.resume();
    if (tail) {
      // pressed again inside the tail: one clip, not two
      clearTimeout(tail);
      tail = null;
    } else {
      chunks = before;
    }
    before = [];
    recording = true;
    orb?.set("listening");
    if (!pressedAt) pressedAt = performance.now();
    talk.dataset.on = "1";
    talk.textContent = "listening";
    show("");
    navigator.vibrate?.(12);
  }

  // People let go as the last word leaves their mouth, and the phone still
  // has a buffer of it in flight: "hey how's it going" arrived as "hey how's
  // it go". So recording runs on a little after the finger lifts.
  function stop(e) {
    e?.preventDefault();
    if (!recording || tail) return;
    talk.dataset.on = "0";
    talk.textContent = "hold to talk";
    held = performance.now() - pressedAt;
    tail = setTimeout(() => {
      pressedAt = 0;
      tail = null;
      recording = false;
      orb?.set(deskVerb);
      void send();
    }, TAIL_MS);
  }

  async function send() {
    let total = 0;
    for (const c of chunks) total += c.length;
    // The held time, not the clip: the clip always carries the pre-roll and
    // the tail, so a tap would otherwise send most of a second of room noise.
    if (held < 300 || total < RATE * 0.25) {
      chunks = [];
      return show("hold it while you talk");
    }
    const pcm = new Int16Array(total);
    let i = 0;
    for (const c of chunks)
      for (let j = 0; j < c.length; j++) {
        const v = Math.max(-1, Math.min(1, c[j]));
        pcm[i++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
    chunks = [];
    talk.disabled = true;
    show("…", 0);
    try {
      const r = await fetch("/audio", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: pcm.buffer,
      });
      const j = await r.json();
      show(j.text ? `“${j.text}”` : j.error || "nothing heard");
    } catch (err) {
      show(`could not reach Kikoe: ${err.message}`);
    } finally {
      talk.disabled = false;
    }
  }

  talk.addEventListener("pointerdown", async (e) => {
    e.preventDefault();
    if (await open()) start(e);
  });
  talk.addEventListener("pointerup", stop);
  talk.addEventListener("pointercancel", stop);
  talk.addEventListener("pointerleave", stop);
  talk.addEventListener("contextmenu", (e) => e.preventDefault());
})();
