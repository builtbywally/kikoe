// The IDE on the desk (the IDE plan, step 3): a files card for the project
// in view, and an editor card (Monaco, the editor of VS Code) per file. Files
// come from the daemon's /fs routes, inside the project's folder only. A save
// carries the time the file was read, so an agent's write since is never
// overwritten: the card says so and offers reload, keep mine, or compare.
//
// Loaded before room.js, which asks window.kikIde to draw these kinds.
// Monaco (vendor/monaco, 14 MB) is loaded on the first editor, not before.
//
//   window.kikIde = { kinds, body(pin, card), open(kind, path), onFs(frame) }
(() => {
  const kinds = new Set(["files", "editor"]);
  const api = (method, path, body) => window.room.api(method, path, body);
  const open = (kind, path = "") => api("POST", "/ide/open", { kind, path });
  const enc = encodeURIComponent;

  /** open editors by path: { editor, model, mtime, dirty, card, banner, mark } */
  const editors = new Map();
  /** the files cards' refreshers */
  const trees = new Set();

  // --- Monaco, loaded once ----------------------------------------------------------

  let monaco = null;
  function loadMonaco() {
    monaco ??= new Promise((resolve, reject) => {
      // the workers are bundled beside the editor (scripts/build-monaco.mjs)
      self.MonacoEnvironment = {
        getWorkerUrl(_id, label) {
          const name =
            label === "typescript" || label === "javascript"
              ? "ts"
              : label === "json"
                ? "json"
                : label === "css" || label === "scss" || label === "less"
                  ? "css"
                  : label === "html" || label === "handlebars" || label === "razor"
                    ? "html"
                    : "editor";
          return `vendor/monaco/${name}.worker.js`;
        },
      };
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "vendor/monaco/editor.css";
      document.head.append(css);
      const s = document.createElement("script");
      s.src = "vendor/monaco/editor.js";
      s.onload = () => {
        const m = window.KikMonaco;
        theme(m);
        addEventListener("kik:theme", () => theme(m));
        resolve(m);
      };
      s.onerror = () => reject(new Error("the editor did not load"));
      document.head.append(s);
    });
    return monaco;
  }

  /** The editor in the desk's colours, read from the tokens. */
  function theme(m) {
    const css = getComputedStyle(document.documentElement);
    const tok = (n, f) => (css.getPropertyValue(n).trim() || f).replace("#", "");
    const accent = tok("--accent", "#ff2e88");
    const accent2 = tok("--accent-2", "#a855f7");
    const accent3 = tok("--accent-3", "#ffaa3c");
    const ink = tok("--ink", "#f6e9f1");
    const muted = tok("--muted", "#8a7884");
    m.editor.defineTheme("kik", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "", foreground: ink },
        { token: "comment", foreground: muted, fontStyle: "italic" },
        { token: "keyword", foreground: accent },
        { token: "string", foreground: accent3 },
        { token: "number", foreground: accent2 },
        { token: "type", foreground: accent2 },
        { token: "regexp", foreground: accent3 },
      ],
      colors: {
        "editor.background": "#00000000",
        "editor.foreground": `#${ink}`,
        "editorCursor.foreground": `#${accent}`,
        "editor.selectionBackground": `#${accent}44`,
        "editor.lineHighlightBackground": "#ffffff08",
        "editorLineNumber.foreground": `#${muted}88`,
        "editorLineNumber.activeForeground": `#${accent}`,
        "editorIndentGuide.background1": "#ffffff0d",
        "editorWidget.background": "#120a14",
        "editorWidget.border": `#${accent}55`,
        "minimap.background": "#00000000",
        "scrollbarSlider.background": `#${accent}22`,
        "scrollbarSlider.hoverBackground": `#${accent}44`,
      },
    });
    m.editor.setTheme("kik");
  }

  function languageOf(m, path) {
    const lower = path.toLowerCase();
    for (const l of m.languages.getLanguages()) {
      if (l.extensions?.some((x) => lower.endsWith(x.toLowerCase()))) return l.id;
      if (
        l.filenames?.some((x) => lower.endsWith(`/${x.toLowerCase()}`) || lower === x.toLowerCase())
      )
        return l.id;
    }
    return "plaintext";
  }

  // --- the editor card ------------------------------------------------------------------

  function editorBody(p, card) {
    const path = String(p.body || "");
    const wrap = document.createElement("div");
    wrap.className = "ide-editor";
    wrap.dataset.nodrag = "1";
    wrap.dataset.scroll = "1";
    wrap.innerHTML = `
      <div class="ide-bar"><span class="ide-path"></span><span class="ide-dirty" hidden>●</span>
        <span class="ide-sp"></span><button class="ide-save" type="button">save</button></div>
      <div class="ide-banner" hidden><span>Changed on disk since you opened it.</span>
        <button type="button" data-do="reload">reload</button>
        <button type="button" data-do="mine">keep mine</button>
        <button type="button" data-do="compare">compare</button></div>
      <div class="ide-host"><div class="ide-wait">opening ${path.replace(/[<&]/g, "")}…</div></div>`;
    wrap.querySelector(".ide-path").textContent = path;
    const host = wrap.querySelector(".ide-host");
    const banner = wrap.querySelector(".ide-banner");
    const mark = wrap.querySelector(".ide-dirty");
    const ed = { path, card, banner, mark, mtime: 0, dirty: false, editor: null, model: null };
    editors.set(path, ed);

    const setDirty = (on) => {
      ed.dirty = on;
      mark.hidden = !on;
      card.dataset.dirty = on ? "1" : "";
    };
    async function save() {
      if (!ed.model) return;
      const r = await api("POST", "/fs/write", {
        path,
        text: ed.model.getValue(),
        mtime: ed.mtime,
      });
      if (r.status === 409) {
        banner.hidden = false;
        window.kik.feel?.("error");
        return;
      }
      if (!r.ok) {
        window.kik.feel?.("error");
        return;
      }
      ed.mtime = r.data.mtime;
      setDirty(false);
      banner.hidden = true;
      window.kik.feel?.("save");
    }
    wrap.querySelector(".ide-save").addEventListener("click", save);
    banner.addEventListener("click", async (e) => {
      const what = e.target.closest("button")?.dataset.do;
      if (!what) return;
      if (what === "mine") {
        // overwrite, knowingly: the next save goes through
        const r = await api("GET", `/fs/read?path=${enc(path)}`);
        if (r.ok) ed.mtime = r.data.mtime;
        banner.hidden = true;
        return save();
      }
      const r = await api("GET", `/fs/read?path=${enc(path)}`);
      if (!r.ok) return;
      if (what === "reload") {
        replaceText(ed, r.data.text, r.data.mtime);
        banner.hidden = true;
      } else compare(ed, r.data.text);
    });

    (async () => {
      const [m, r] = await Promise.all([loadMonaco(), api("GET", `/fs/read?path=${enc(path)}`)]);
      host.textContent = "";
      if (!r.ok) {
        host.innerHTML = `<div class="ide-wait"></div>`;
        host.firstChild.textContent = r.data.error ?? "could not open it";
        return;
      }
      const uri = m.Uri.parse(`file:///${path}`);
      ed.model =
        m.editor.getModel(uri) ?? m.editor.createModel(r.data.text, languageOf(m, path), uri);
      ed.mtime = r.data.mtime;
      ed.editor = m.editor.create(host, {
        model: ed.model,
        theme: "kik",
        automaticLayout: true,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"),
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: true, renderCharacters: false, scale: 1 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        padding: { top: 10 },
        fixedOverflowWidgets: true,
        renderLineHighlight: "all",
      });
      ed.editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, save);
      ed.editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyP, () =>
        window.kikPalette.open("files"),
      );
      ed.model.onDidChangeContent(() => {
        if (!ed.quiet) setDirty(true);
      });
      // Monaco measures in screen pixels: editing is at 100%, so a click on an
      // editor seen from afar brings it close first
      host.addEventListener(
        "pointerdown",
        (e) => {
          if (Math.abs((window.board?.zoom ?? 1) - 1) > 0.02) {
            e.preventDefault();
            e.stopPropagation();
            window.board.focus(p.id);
            setTimeout(() => ed.editor?.focus(), 450);
          }
        },
        true,
      );
    })();
    return wrap;
  }

  /** New text from disk, keeping the cursor and scroll where they were. */
  function replaceText(ed, text, mtime) {
    if (!ed.model) return;
    const view = ed.editor?.saveViewState();
    ed.quiet = true;
    ed.model.setValue(text);
    ed.quiet = false;
    if (view) ed.editor.restoreViewState(view);
    ed.mtime = mtime;
    ed.dirty = false;
    ed.mark.hidden = true;
    ed.card.dataset.dirty = "";
    ed.card.classList.remove("ide-touched");
    void ed.card.offsetWidth;
    ed.card.classList.add("ide-touched");
  }

  /** Disk on the left, yours on the right, in place of the editor until closed. */
  async function compare(ed, disk) {
    const m = await loadMonaco();
    const host = ed.card.querySelector(".ide-host");
    const holder = document.createElement("div");
    holder.className = "ide-diff";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ide-diff-close";
    close.textContent = "back to editing";
    host.append(holder, close);
    const diff = m.editor.createDiffEditor(holder, {
      theme: "kik",
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
    });
    const left = m.editor.createModel(disk, ed.model.getLanguageId());
    diff.setModel({ original: left, modified: ed.model });
    close.addEventListener("click", () => {
      diff.dispose();
      left.dispose();
      holder.remove();
      close.remove();
    });
  }

  // --- the files card -------------------------------------------------------------------

  const ICON = {
    ts: "ts",
    tsx: "ts",
    js: "js",
    mjs: "js",
    cjs: "js",
    jsx: "js",
    json: "{}",
    md: "md",
    css: "#",
    html: "<>",
    py: "py",
    rs: "rs",
    go: "go",
    yml: "y",
    yaml: "y",
    svg: "◇",
    png: "▣",
    jpg: "▣",
  };
  const iconOf = (name) => ICON[name.split(".").pop()?.toLowerCase() ?? ""] ?? "·";

  function filesBody(p, card) {
    const wrap = document.createElement("div");
    wrap.className = "ide-files";
    wrap.dataset.nodrag = "1";
    wrap.innerHTML = `
      <div class="ide-bar"><input class="ide-filter" type="text" spellcheck="false" placeholder="filter files…" />
        <button type="button" data-do="newfile" title="new file">+</button>
        <button type="button" data-do="refresh" title="refresh">↻</button></div>
      <ul class="ide-tree" data-scroll="1"></ul>`;
    const tree = wrap.querySelector(".ide-tree");
    const filter = wrap.querySelector(".ide-filter");
    const memo = `kik.files.${p.project || "x"}`;
    const expanded = new Set(JSON.parse(localStorage.getItem(memo) || "[]"));
    const cache = new Map();
    let all = null;

    async function load(dir) {
      const r = await api("GET", `/fs/list?path=${enc(dir)}`);
      cache.set(dir, r.ok ? r.data.entries : { error: r.data.error });
    }
    async function draw() {
      const q = filter.value.trim().toLowerCase();
      tree.textContent = "";
      if (q) {
        all ??= (await api("GET", "/fs/files")).data.files ?? [];
        const hits = all.filter((f) => f.toLowerCase().includes(q)).slice(0, 300);
        for (const f of hits) tree.append(row({ name: f, path: f, dir: false }, 0, true));
        if (!hits.length) tree.append(note("nothing matches"));
        return;
      }
      if (!cache.has("")) await load("");
      const walk = async (dir, depth) => {
        const entries = cache.get(dir);
        if (!Array.isArray(entries)) {
          tree.append(note(entries?.error ?? "…"));
          return;
        }
        for (const e of entries) {
          tree.append(row(e, depth));
          if (e.dir && expanded.has(e.path)) {
            if (!cache.has(e.path)) await load(e.path);
            await walk(e.path, depth + 1);
          }
        }
      };
      await walk("", 0);
    }
    const note = (t) => {
      const li = document.createElement("li");
      li.className = "ide-note";
      li.textContent = t;
      return li;
    };
    function row(e, depth, flat = false) {
      const li = document.createElement("li");
      li.className = e.dir ? "dir" : "file";
      if (e.dir && expanded.has(e.path)) li.classList.add("open");
      if (editors.has(e.path)) li.classList.add("is-open");
      li.style.paddingLeft = `${8 + depth * 14}px`;
      li.dataset.path = e.path;
      li.draggable = !e.dir;
      const ic = document.createElement("i");
      ic.textContent = e.dir ? "›" : iconOf(e.name);
      const nm = document.createElement("span");
      nm.textContent = flat ? e.path : e.name;
      li.append(ic, nm);
      li.addEventListener("click", () => {
        if (e.dir) {
          if (expanded.has(e.path)) expanded.delete(e.path);
          else expanded.add(e.path);
          localStorage.setItem(memo, JSON.stringify([...expanded]));
          window.kik.feel?.("tick");
          void draw();
        } else {
          window.kik.feel?.("open");
          void open("editor", e.path);
        }
      });
      li.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/kik-file", e.path);
        ev.dataTransfer.setData("text/plain", e.path);
      });
      li.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const parent = e.dir ? e.path : e.path.split("/").slice(0, -1).join("/");
        window.kik.menu?.(ev.clientX, ev.clientY, [
          ...(e.dir ? [] : [{ title: "Open", run: () => open("editor", e.path) }]),
          {
            title: "Ask Kik about it",
            run: () => window.kikPalette.open("ask", "", `About ${e.path} in this project:`),
          },
          { title: "Copy its path", run: () => navigator.clipboard?.writeText(e.path) },
          "-",
          { title: "New file here", run: () => create(parent, false) },
          { title: "New folder here", run: () => create(parent, true) },
          { title: "Rename", run: () => rename(e) },
          { title: "Delete", run: () => remove(e) },
        ]);
      });
      return li;
    }
    async function create(parent, dir) {
      const name = await ask(dir ? "New folder" : "New file", "");
      if (!name) return;
      const path = parent ? `${parent}/${name}` : name;
      const r = await api("POST", "/fs/create", { path, dir });
      if (!r.ok) return fail(r);
      if (parent) expanded.add(parent);
      await refresh();
      if (!dir) void open("editor", r.data.path);
    }
    async function rename(e) {
      const name = await ask("Rename to", e.name);
      if (!name || name === e.name) return;
      const to = [...e.path.split("/").slice(0, -1), name].join("/");
      const r = await api("POST", "/fs/rename", { from: e.path, to });
      if (!r.ok) return fail(r);
      await refresh();
    }
    async function remove(e) {
      if (!(await confirmBox(`Delete ${e.path}${e.dir ? " and everything in it" : ""}?`))) return;
      const r = await api("POST", "/fs/delete", { path: e.path });
      if (!r.ok) return fail(r);
      await refresh();
    }
    function fail(r) {
      window.kik.feel?.("error");
      tree.prepend(note(r.data.error ?? "that did not work"));
    }
    /** a small inline question at the top of the tree, instead of window.prompt */
    function ask(label, value) {
      return new Promise((resolve) => {
        const li = document.createElement("li");
        li.className = "ide-ask";
        li.innerHTML = "<label></label><input type='text' spellcheck='false' />";
        li.firstChild.textContent = label;
        const input = li.lastChild;
        input.value = value;
        tree.prepend(li);
        input.focus();
        input.select();
        const done = (v) => {
          li.remove();
          resolve(v);
        };
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") done(input.value.trim());
          if (ev.key === "Escape") done("");
          ev.stopPropagation();
        });
        input.addEventListener("blur", () => done(""));
      });
    }
    function confirmBox(text) {
      return new Promise((resolve) => {
        const li = document.createElement("li");
        li.className = "ide-ask";
        li.innerHTML =
          "<label></label><button type='button'>delete</button><button type='button'>keep</button>";
        li.firstChild.textContent = text;
        const [yes, no] = li.querySelectorAll("button");
        yes.addEventListener("click", () => {
          li.remove();
          resolve(true);
        });
        no.addEventListener("click", () => {
          li.remove();
          resolve(false);
        });
        tree.prepend(li);
      });
    }
    async function refresh(paths) {
      if (paths) {
        // only the folders that changed, and the flat list for the filter
        for (const f of paths) cache.delete(f.split("/").slice(0, -1).join("/"));
      } else cache.clear();
      all = null;
      await draw();
    }
    wrap.querySelector("[data-do=refresh]").addEventListener("click", () => refresh());
    wrap.querySelector("[data-do=newfile]").addEventListener("click", () => create("", false));
    filter.addEventListener("input", () => void draw());
    filter.addEventListener("keydown", (e) => e.stopPropagation());
    const live = { refresh, card };
    trees.add(live);
    // a card that left the desk stops listening
    const gone = new MutationObserver(() => {
      if (!card.isConnected) {
        trees.delete(live);
        gone.disconnect();
      }
    });
    requestAnimationFrame(() => gone.observe(document.body, { childList: true, subtree: true }));
    void draw();
    return wrap;
  }

  // --- what changed on disk (the daemon's "fs" frames) ---------------------------------

  async function onFs(f) {
    const paths = Array.isArray(f.paths) ? f.paths.map(String) : [];
    if (!paths.length) return;
    for (const t of trees) void t.refresh(paths);
    if (f.by === "you") return;
    for (const path of paths) {
      const ed = editors.get(path);
      if (!ed?.model) continue;
      if (!ed.card.isConnected) {
        editors.delete(path);
        continue;
      }
      const r = await api("GET", `/fs/read?path=${enc(path)}`);
      if (!r.ok || Math.abs(r.data.mtime - ed.mtime) <= 1) continue;
      // Someone else wrote it. Untouched here: take theirs. Touched: ask.
      if (!ed.dirty && r.data.text !== ed.model.getValue())
        replaceText(ed, r.data.text, r.data.mtime);
      else if (!ed.dirty) ed.mtime = r.data.mtime;
      else ed.banner.hidden = false;
    }
  }

  // --- the palette: quick open, search, and the IDE's actions ---------------------------

  let fileList = null;
  let fileListAt = 0;
  async function files() {
    if (!fileList || Date.now() - fileListAt > 15000) {
      const r = await api("GET", "/fs/files");
      fileList = r.ok ? r.data.files : [];
      fileListAt = Date.now();
    }
    return fileList;
  }
  function fuzzy(text, q) {
    const t = text.toLowerCase();
    let at = 0;
    let total = 0;
    for (const ch of q.toLowerCase()) {
      const i = t.indexOf(ch, at);
      if (i < 0) return 0;
      total += i === at ? 3 : 1;
      at = i + 1;
    }
    // the name counts more than the folders around it
    const name = t.slice(t.lastIndexOf("/") + 1);
    return total + (name.includes(q.toLowerCase()) ? 20 : 0) - t.length * 0.01;
  }
  function wire() {
    const P = window.kikPalette;
    const A = window.kik?.actions;
    if (!P?.mode || !A) return;
    P.mode("files", {
      label: "open file",
      placeholder: "a file in this project",
      keys: [false, "p"],
      async items(q) {
        const list = await files();
        const ranked = q
          ? list
              .map((f) => ({ f, s: fuzzy(f, q) }))
              .filter((x) => x.s > 0)
              .sort((a, b) => b.s - a.s)
              .map((x) => x.f)
          : list;
        return ranked.slice(0, 30).map((f) => ({
          title: f.split("/").pop(),
          hint: f.split("/").slice(0, -1).join("/"),
          run: () => open("editor", f),
        }));
      },
    });
    P.mode("search", {
      label: "search",
      placeholder: "text in this project's files",
      keys: [true, "f"],
      async items(q) {
        if (q.length < 2) return [];
        const r = await api("GET", `/fs/search?q=${enc(q)}`);
        return (r.data.hits ?? []).slice(0, 60).map((h) => ({
          title: h.text.trim() || h.path,
          hint: `${h.path}:${h.line}`,
          run: async () => {
            await open("editor", h.path);
            // the editor may still be opening: reveal the line when it is there
            for (let i = 0; i < 40; i++) {
              const ed = editors.get(h.path)?.editor;
              if (ed) {
                ed.revealLineInCenter(h.line);
                ed.setPosition({ lineNumber: h.line, column: 1 });
                ed.focus();
                return;
              }
              await new Promise((r) => setTimeout(r, 100));
            }
          },
        }));
      },
    });
    A.register({
      id: "ide.files",
      title: "Files of this project",
      group: "code",
      run: () => open("files"),
    });
    A.register({
      id: "ide.quick",
      title: "Open a file…",
      keys: "Ctrl P",
      group: "code",
      run: () => P.open("files"),
    });
    A.register({
      id: "ide.search",
      title: "Search in files…",
      keys: "Ctrl Shift F",
      group: "code",
      run: () => P.open("search"),
    });
    window.kik.cardActions = ((before) => (p) => {
      const out = before ? before(p) : [];
      if (p.kind === "editor")
        out.push({ title: "Show it in the files", run: () => open("files") });
      return out;
    })(window.kik.cardActions);
    const canvas = window.kik.canvasActions;
    window.kik.canvasActions = () => [
      ...(canvas ? canvas() : []),
      { title: "Files of this project", run: () => open("files") },
      { title: "Open a file…", keys: "Ctrl P", run: () => P.open("files") },
    ];
  }
  // palette.js and interact.js are loaded before this file
  wire();

  // a file from the tree let go on the empty desk opens there
  addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("text/kik-file") && e.target.closest?.("#desk"))
      e.preventDefault();
  });
  addEventListener("drop", (e) => {
    const path = e.dataTransfer?.getData("text/kik-file");
    if (!path) return;
    e.preventDefault();
    const card = e.target.closest?.(".pin");
    const p = card && window.kikPins?.get(card.dataset.id);
    // onto Kik's conversation or an agent's card: a question about the file
    if (p && (p.kind === "conversation" || p.kind === "session"))
      window.kikPalette.open("ask", "", `About ${path} in this project:`);
    else void open("editor", path);
  });

  window.kikIde = {
    kinds,
    open,
    onFs,
    body: (p, card) => (p.kind === "files" ? filesBody(p, card) : editorBody(p, card)),
  };
})();
