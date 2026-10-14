// Everything Kikoe can do, registered once with the palette (palette.js).
// Buttons, keys, right-click menus and Kik's voice reach the same ids.
// Loaded after room.js, whose view functions (showDesk, showBody,
// showControl) are globals of the page.
(() => {
  const A = window.kik.actions;
  const reg = (id, title, run, extra = {}) => A.register({ id, title, run, ...extra });

  for (const area of ["home", "life", "comms", "work", "you"])
    reg(`go.${area}`, `Go to ${area}`, () => window.kikDesk?.go(area), { group: "desk" });
  reg("go.all", "The whole desk", () => window.kikDesk?.go("all"), { group: "desk" });
  reg("view.desk", "Show the desk", () => showDesk(), { keys: "Esc", group: "view" });
  reg("view.body", "Show Kik's body", () => void showBody(), { keys: "K", group: "view" });
  reg("view.control", "Control room", () => void showControl(), { keys: "C", group: "view" });
  reg("view.settings", "Settings", () => window.settingsPanel?.open(), { group: "view" });
  reg("board.clear", "Clear the board", () => window.room.clearBoard(), { group: "board" });
  reg("zoom.in", "Zoom in", () => window.board.zoomTo(window.board.zoom * 1.25), {
    group: "canvas",
  });
  reg("zoom.out", "Zoom out", () => window.board.zoomTo(window.board.zoom / 1.25), {
    group: "canvas",
  });
  reg("zoom.reset", "Zoom to 100%", () => window.board.zoomTo(1), { group: "canvas" });
  reg("ask", "Ask Kik…", () => window.kikPalette.open("ask"), { keys: "type it", group: "kik" });
  reg("answer.yes", "Answer yes", () => window.room.answerWord("yes"), { keys: "Y", group: "kik" });
  reg("answer.no", "Answer no", () => window.room.answerWord("no"), { keys: "N", group: "kik" });
  for (const [mode, title] of [
    ["push", "Mic: push to talk"],
    ["wake", "Mic: wake word (hey Kik)"],
    ["open", "Mic: always listening"],
    ["muted", "Mic: off (phone only)"],
  ])
    reg(`mic.${mode}`, title, () => window.room.setMicMode?.(mode), { group: "mic" });
  reg("theme.neon", "Theme: neon", () => window.kikTheme?.set("neon"), { group: "look" });
  reg("theme.ember", "Theme: ember", () => window.kikTheme?.set("ember"), { group: "look" });
  reg(
    "sounds.toggle",
    "Sounds on or off",
    () =>
      localStorage.setItem(
        "kik.sounds",
        localStorage.getItem("kik.sounds") === "off" ? "on" : "off",
      ),
    { group: "look" },
  );
  reg(
    "hands",
    "Hands over the camera (in the body)",
    async () => {
      await showBody();
      window.holoApi?.hands(true);
    },
    { keys: "X in the body", group: "view" },
  );
})();
