// Which palette of the design system (tokens.css) this page wears: neon, or
// ember as the alternate. One choice for every surface: the desk's ◐,
// Settings → Look and the island all go through here. Kept in localStorage
// (the island and the Room share it) and in the settings, where the app
// reads it for the window's own colours.
(() => {
  const KEY = "kik.theme";
  const valid = (t) => (t === "ember" ? "ember" : "neon");
  const stored = localStorage.getItem(KEY) ?? localStorage.getItem("kik.desk.theme");
  const apply = (t) => {
    document.documentElement.dataset.theme = valid(t);
  };
  apply(stored);
  window.kikTheme = {
    get: () => valid(document.documentElement.dataset.theme),
    /** Wear a palette, remember it, tell the app and anything listening. */
    set(t, save = true) {
      const theme = valid(t);
      apply(theme);
      localStorage.setItem(KEY, theme);
      if (save) void window.kikoe?.save?.({ theme });
      window.dispatchEvent(new CustomEvent("kik:theme", { detail: theme }));
    },
  };
  // another window (the Room, the island) changed it
  window.addEventListener("storage", (e) => {
    if (e.key === KEY && e.newValue) {
      apply(e.newValue);
      window.dispatchEvent(new CustomEvent("kik:theme", { detail: valid(e.newValue) }));
    }
  });
})();
