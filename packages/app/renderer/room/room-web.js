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
  const readOnly = token.startsWith("v-");
  if (readOnly) document.documentElement.dataset.readonly = "true";
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
    updatePin: (id, patch) => post(`/pins/${encodeURIComponent(id)}/update`, patch),
    sayToKik: (text) => post("/say", { text }),
    openSettings: () => {},
  };
})();
