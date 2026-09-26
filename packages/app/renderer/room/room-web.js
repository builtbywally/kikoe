// The Room in a plain browser: the second screen. When the page is served by
// the daemon (an iPad on the desk, through a tunnel the user set up) there is
// no preload, so this shim provides the same `window.room` the Electron
// preload does, against the daemon's HTTP surface. The token rides in the
// URL the user opened and is never written anywhere.
//
// Loaded before room.js; does nothing inside the app, where the preload
// already defined window.room.

(() => {
  if (window.room) return;
  const params = new URLSearchParams(location.search);
  const token = params.get("token") || "";
  // On the phone the page comes through the walkie, which is signed in by
  // its cookie and reads from the daemon as a viewer; the page itself holds
  // no token at all. It watches and talks; it does not act (yet).
  const phone = params.get("phone") === "1";
  const readOnly = token.startsWith("v-") || phone;
  if (readOnly) document.documentElement.dataset.readonly = "true";
  if (phone) document.documentElement.dataset.phone = "true";
  const base = location.origin;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = (path, body) =>
    fetch(base + path, { method: "POST", headers, body: JSON.stringify(body ?? {}) })
      .then((r) => r.json())
      .catch((e) => ({ error: String(e) }));

  window.room = {
    stream(onFrame, onStatus) {
      let reconnecting = false;
      const connect = () => {
        reconnecting = false;
        const source = new EventSource(`${base}/stream?token=${encodeURIComponent(token)}`);
        source.onopen = () => onStatus("connected");
        source.onmessage = (e) => {
          let frame;
          try {
            frame = JSON.parse(e.data);
          } catch {
            return;
          }
          try {
            onFrame(frame);
          } catch (err) {
            console.error("room: handler failed for", frame?.type, err);
          }
        };
        source.onerror = () => {
          if (reconnecting) return;
          reconnecting = true;
          onStatus("disconnected");
          source.close();
          setTimeout(connect, 2000);
        };
      };
      connect();
    },
    state: () =>
      fetch(`${base}/state`, { headers })
        .then((r) => r.json())
        .catch(() => null),
    answerPin: (id, answer) => post(`/pins/${encodeURIComponent(id)}/answer`, { answer }),
    answerWord: (word) => post("/answer", { word }),
    removePin: (id) =>
      fetch(`${base}/pins/${encodeURIComponent(id)}`, { method: "DELETE", headers }).then((r) =>
        r.json(),
      ),
    clearBoard: () => post("/pins/clear"),
    actOnPin: (id, action) => post(`/pins/${id}/act`, { action }),
    updatePin: (id, patch) => post(`/pins/${encodeURIComponent(id)}/update`, patch),
    // On the phone, /say is the walkie's own: typing is talking, as a viewer
    // could not; the daemon's /say is never reached from here.
    sayToKik: (text) => post("/say", { text }),
    setMicMode: (mode) => post("/mic-mode", { mode }),
    native: false,
    artifactBase: base,
    openArtifact: (id, url) => {
      const p = document.querySelector(`[data-id="${id}"][data-kind="web"] iframe`);
      const to = url || p?.src;
      if (to) {
        window.open(to, "_blank", "noopener");
        return { ok: true };
      }
      return { error: "open it from the app" };
    },
    saveArtifact: () => ({ error: "save it from the app" }),
    backdropUrl: () => `/backdrop?token=${encodeURIComponent(token)}`,
    openSettings: () => {},
  };
})();
