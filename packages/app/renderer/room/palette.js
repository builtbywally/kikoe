// The command palette: every action in Kikoe, one keystroke away (Ctrl+K or
// Ctrl+Shift+P). One registry, so a button, a key, a right-click menu and
// Kik's voice all reach the same action by id. What you type that matches no
// action goes to Kik as a sentence, so the palette is also the way to talk
// to it without the mic.
//
//   window.kik.actions.register({ id, title, hint, keys, group, when, run })
//   window.kik.actions.run(id)
//   window.kikPalette.open(mode?, seed?)   mode: "actions" | "ask"
//   window.kikPalette.provider(fn)          more results for a query (files, …)
//   window.kikPalette.mode(name, { label, placeholder, items(q), keys })
//                                            a palette of its own (quick open,
//                                            search in files: ide.js)
(() => {
  const actions = new Map();
  const providers = [];
  const modes = new Map();

  /** Fuzzy score: every letter in order, rewarded for starts and runs. 0 is no match. */
  function score(text, q) {
    if (!q) return 1;
    const t = text.toLowerCase();
    const s = q.toLowerCase();
    let at = 0;
    let total = 0;
    let run = 0;
    for (const ch of s) {
      const i = t.indexOf(ch, at);
      if (i < 0) return 0;
      run = i === at ? run + 1 : 0;
      total += 1 + run * 2 + (i === 0 || t[i - 1] === " " ? 3 : 0);
      at = i + 1;
    }
    return total / (1 + t.length * 0.02);
  }

  window.kik = window.kik ?? {};
  window.kik.actions = {
    register(a) {
      actions.set(a.id, a);
    },
    run(id, ...args) {
      const a = actions.get(id);
      if (!a) return false;
      window.kik.feel?.("act");
      a.run(...args);
      return true;
    },
    list: () => [...actions.values()].filter((a) => !a.when || a.when()),
  };

  // --- the palette ---------------------------------------------------------------------

  const el = document.createElement("div");
  el.className = "palette";
  el.hidden = true;
  el.innerHTML = `
    <div class="pal-box" role="dialog" aria-label="command palette">
      <div class="pal-in"><span class="pal-mode"></span><input type="text" spellcheck="false" autocomplete="off" /></div>
      <ul class="pal-list" role="listbox"></ul>
      <div class="pal-foot"><span>↑↓ choose · ⏎ run · esc close</span><span>type anything to ask Kik</span></div>
    </div>`;
  document.body.append(el);
  const input = el.querySelector("input");
  const list = el.querySelector(".pal-list");
  const modeEl = el.querySelector(".pal-mode");
  let items = [];
  let sel = 0;
  let mode = "actions";
  let context = "";

  async function refresh() {
    const q = input.value.trim();
    if (mode === "ask") {
      items = [{ title: q ? `Ask Kik: ${q}` : "Ask Kik…", hint: context, run: () => ask(q) }];
    } else if (modes.has(mode)) {
      let found = [];
      try {
        found = (await modes.get(mode).items(q)) ?? [];
      } catch {
        /* the mode's trouble is not the palette's */
      }
      if (input.value.trim() !== q || !modes.has(mode)) return;
      items = found;
    } else {
      const ranked = window.kik.actions
        .list()
        .map((a) => ({ a, s: score(`${a.title} ${a.group ?? ""}`, q) }))
        .filter((x) => x.s > 0)
        .sort((x, y) => y.s - x.s)
        .slice(0, 12)
        .map((x) => ({
          title: x.a.title,
          hint: x.a.keys ?? x.a.group ?? "",
          run: () => window.kik.actions.run(x.a.id),
        }));
      items = ranked;
      for (const p of providers) {
        try {
          const more = (await p(q)) ?? [];
          if (input.value.trim() !== q) return; // typed on; a newer refresh is coming
          items = items.concat(more);
        } catch {
          /* a provider's trouble is not the palette's */
        }
      }
      if (q)
        items.push({ title: `Ask Kik: ${q}`, hint: "⏎ sends it", run: () => ask(q), ask: true });
    }
    sel = Math.min(sel, Math.max(0, items.length - 1));
    draw();
  }
  function draw() {
    list.textContent = "";
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = `${i === sel ? "on" : ""} ${it.ask ? "ask" : ""}`;
      li.innerHTML = "<span></span><i></i>";
      li.firstChild.textContent = it.title;
      li.lastChild.textContent = it.hint ?? "";
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        sel = i;
        choose();
      });
      list.append(li);
    });
    list.children[sel]?.scrollIntoView({ block: "nearest" });
  }
  function ask(q) {
    const text = q.trim();
    if (!text) return;
    window.kik.feel?.("send");
    void window.room?.sayToKik?.(context ? `${context} ${text}` : text);
  }
  function choose() {
    const it = items[sel];
    close();
    it?.run();
  }
  function open(m = "actions", seed = "", ctx = "") {
    mode = m;
    context = ctx;
    const own = modes.get(m);
    modeEl.textContent = m === "ask" ? "ask kik" : (own?.label ?? "");
    el.hidden = false;
    input.value = seed;
    input.placeholder =
      own?.placeholder ??
      (m === "ask" ? "what do you want to ask?" : "an action, a file, or anything to ask Kik");
    sel = 0;
    window.kik.feel?.("open");
    void refresh();
    requestAnimationFrame(() => input.focus());
  }
  function close() {
    el.hidden = true;
    input.blur();
  }
  input.addEventListener("input", () => {
    sel = 0;
    void refresh();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") sel = Math.min(items.length - 1, sel + 1);
    else if (e.key === "ArrowUp") sel = Math.max(0, sel - 1);
    else if (e.key === "Enter") return choose();
    else if (e.key === "Escape") return close();
    else return;
    e.preventDefault();
    draw();
  });
  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) close();
  });
  document.addEventListener(
    "keydown",
    (e) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (k === "k" || (e.shiftKey && k === "p"))) {
        e.preventDefault();
        e.stopPropagation();
        el.hidden ? open() : close();
        return;
      }
      // a mode's own key: Ctrl+P quick open, Ctrl+Shift+F search
      for (const [name, m] of modes) {
        if (!m.keys || !(e.ctrlKey || e.metaKey)) continue;
        const [shift, key] = m.keys;
        if (k === key && e.shiftKey === shift) {
          e.preventDefault();
          e.stopPropagation();
          open(name);
          return;
        }
      }
    },
    true,
  );

  window.kikPalette = {
    open,
    close,
    provider: (fn) => providers.push(fn),
    mode: (name, m) => modes.set(name, m),
    get open_() {
      return !el.hidden;
    },
  };
})();
