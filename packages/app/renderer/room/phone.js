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
    '<button type="button" id="phone-talk" aria-label="hold to talk to Kik">hold to talk</button>';
  document.body.appendChild(wrap);
  const talk = wrap.querySelector("#phone-talk");
  const said = wrap.querySelector("#phone-said");

  let ctx = null;
  let chunks = [];
  let recording = false;
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
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      if (recording) chunks.push(downsample(e.inputBuffer.getChannelData(0), ctx.sampleRate, RATE));
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
    chunks = [];
    recording = true;
    talk.dataset.on = "1";
    talk.textContent = "listening";
    show("");
    navigator.vibrate?.(12);
  }

  async function stop(e) {
    e?.preventDefault();
    if (!recording) return;
    recording = false;
    talk.dataset.on = "0";
    talk.textContent = "hold to talk";
    let total = 0;
    for (const c of chunks) total += c.length;
    if (total < RATE * 0.25) return show("too short");
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
