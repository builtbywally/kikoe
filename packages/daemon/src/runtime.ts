/**
 * The artifact runtime: the page a card frames.
 *
 * Claude's own artifacts are not better HTML; they run in a richer place.
 * The model writes React with Tailwind classes, and the frame supplies
 * React, Babel for JSX, Tailwind, icons and charts from a CDN allowlist.
 * This is that place inside Kikoe. An artifact is served by the daemon at
 * `/artifact/<id>` as a real document with its own content policy, so a
 * card frames a URL instead of inline markup, and the page can load what
 * the policy allows and nothing else. The id is the only key: unguessable,
 * loopback only, and it opens one page, never the daemon's API.
 */

import { withKit } from "./kit.js";
import type { Pin } from "./pins.js";

/** What a served artifact may load. Scripts and styles from the allowlist; images from anywhere. */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://esm.sh",
  "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com",
  "font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com",
  "img-src * data: blob:",
  "media-src * data: blob:",
  "connect-src https: http://127.0.0.1:* http://localhost:*",
  "frame-src https: http://127.0.0.1:* http://localhost:*",
  "form-action 'none'",
].join("; ");

const CDN = {
  react: "https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js",
  reactDom:
    "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js",
  babel: "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.26.4/babel.min.js",
  tailwind: "https://cdn.tailwindcss.com",
  propTypes: "https://cdnjs.cloudflare.com/ajax/libs/prop-types/15.8.1/prop-types.min.js",
  recharts: "https://cdnjs.cloudflare.com/ajax/libs/recharts/2.12.7/Recharts.min.js",
  lucide: "https://unpkg.com/lucide-react@0.468.0/dist/umd/lucide-react.min.js",
};

/** Module names the runtime provides as globals; anything else is dropped with a warning. */
const GLOBALS: Record<string, string> = {
  react: "React",
  "react-dom": "ReactDOM",
  "react-dom/client": "ReactDOM",
  "lucide-react": "LucideReact",
  recharts: "Recharts",
};

const HOOKS =
  "useState, useEffect, useMemo, useRef, useCallback, useReducer, useContext, useLayoutEffect, useId, createContext, Fragment, memo, forwardRef";

/**
 * The names the page already destructures from React before the code runs.
 *
 * This matters more than it looks: every artifact written anywhere begins
 * `import React, { useState } from "react"`, and rewriting that to a second
 * `const { useState } = React` in the same scope is a redeclaration — a
 * SyntaxError that blanks the whole card. The pre-destructure wins; a name
 * already in it is simply dropped from the rewritten import.
 */
const PRE_DECLARED: ReadonlySet<string> = new Set(HOOKS.split(",").map((n) => n.trim()));

/**
 * A component file becomes a page: imports become globals, the default
 * export becomes the root, and Babel compiles the JSX in the frame.
 */
export function wrapReact(source: string, title: string): string {
  let code = stripFences(source);
  const needs = { lucide: false, recharts: false };
  // import lines -> destructuring from the runtime's globals
  code = code.replace(
    /^\s*import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:from\s*)?["']([^"']+)["'];?\s*$/gm,
    (_m, def: string | undefined, named: string | undefined, mod: string) => {
      const g = GLOBALS[mod];
      if (mod === "lucide-react") needs.lucide = true;
      if (mod === "recharts") needs.recharts = true;
      if (!g) return `/* import from ${mod} is not available in this runtime */`;
      const parts: string[] = [];
      if (def && mod !== "react" && mod !== "react-dom") parts.push(`const ${def} = ${g};`);
      if (named?.trim()) {
        const names = named
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
          .map((n) => n.replace(/\s+as\s+/, ": "))
          // React's hooks are already destructured above; declaring them a
          // second time in the same scope is a SyntaxError, not a shadow.
          .filter((n) => !(g === "React" && PRE_DECLARED.has(n.split(":")[0]!.trim())));
        if (names.length) parts.push(`const { ${names.join(", ")} } = ${g};`);
      }
      return parts.join(" ");
    },
  );
  // the root component
  let root = "";
  const named = /export\s+default\s+function\s+(\w+)/.exec(code);
  if (named?.[1]) {
    root = named[1];
    code = code.replace(/export\s+default\s+function/, "function");
  } else {
    const expr = /export\s+default\s+([^;\n]+)/.exec(code);
    if (expr?.[1]) {
      root = "__KikoeRoot";
      code = code.replace(/export\s+default\s+/, "const __KikoeRoot = ");
    } else {
      const fn = /function\s+(App|Main|Page|Root)\b/.exec(code);
      root = fn?.[1] ?? "App";
    }
  }
  code = code.replace(/^\s*export\s+(?=(const|let|function|class)\b)/gm, "");
  if (
    !needs.recharts &&
    /\bRecharts\b|<(Line|Bar|Area|Pie|Radar|Scatter|Composed)Chart\b/.test(code)
  )
    needs.recharts = true;
  // lucide's UMD reads `window.react`, lower case, while React's UMD only
  // ever defines `window.React`. Without this alias every icon in an artifact
  // takes the whole card down with "cannot read forwardRef of undefined",
  // which looks like the artifact's fault and is not.
  const shim = `<script>window.react=window.React;window["react-dom"]=window.ReactDOM;</script>`;
  const scripts = [
    ...[CDN.react, CDN.reactDom, CDN.babel].map((s) => `<script crossorigin src="${s}"></script>`),
    shim,
    ...(needs.recharts ? [CDN.propTypes, CDN.recharts] : [])
      .concat(needs.lucide ? [CDN.lucide] : [])
      .map((s) => `<script crossorigin src="${s}"></script>`),
  ].join("\n");
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${scripts}
<script src="${CDN.tailwind}"></script>
<script>
tailwind.config = { darkMode: "class", theme: { extend: { colors: { ember: "#d2683f", paper: "#f5f1ec", ink: "#14100e", card: "#181815" }, fontFamily: { sans: ["Instrument Sans", "Segoe UI", "system-ui", "sans-serif"], serif: ["Instrument Serif", "Georgia", "serif"], mono: ["IBM Plex Mono", "ui-monospace", "monospace"] } } } };
</script>
<style>
html, body { margin: 0; min-height: 100%; background: #14100e; color: #f5f1ec; font-family: "Instrument Sans", "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
#root { min-height: 100vh; }
.kikoe-error { margin: 0; padding: 24px; color: #d4553f; font: 13px/1.5 ui-monospace, monospace; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="root"></div>
<script>
window.addEventListener("error", (e) => {
  const r = document.getElementById("root");
  if (r && !r.childElementCount) r.innerHTML = '<pre class="kikoe-error">' + String(e.message || e.error || e).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) + "</pre>";
});
</script>
<script type="text/babel" data-presets="react">
const { ${HOOKS} } = React;
${code}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(${root}));
</script>
</body>
</html>`;
}

/** The document a card frames, for any kind that is a page. */
export function renderArtifact(pin: Pin): string | null {
  if (pin.kind === "react") return wrapReact(pin.body, pin.title || "artifact");
  if (pin.kind === "html") return withKit(stripFences(pin.body));
  return null;
}

/** A model's answer with the code fence taken off, if it put one on. */
export function stripFences(text: string): string {
  const m = /^\s*```[\w-]*\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return m?.[1] ?? text;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

/**
 * The designer's brief. Given to the page model with the user's request;
 * it is what separates a product screen from a demo.
 */
export const DESIGN_BRIEF = `You design and build screens for a voice-first developer tool called Kikoe. You get a short brief and you return one complete React component file: the whole page, working, with state where the brief needs it.

Format. Plain JSX, one file, no TypeScript. Start with imports only for react, lucide-react and recharts (nothing else exists). End with "export default function App()". Hooks and Fragment are available; icons come from lucide-react; charts from recharts. Style with Tailwind utility classes only; no CSS files, no external images, no fonts. Draw any illustration inline as SVG. Return the code only: no prose, no fences, no explanation.

Design. Dark by default: page bg #14100e, cards #181815 with a 1px border of white at 14 percent, text #f5f1ec, muted text at 60 percent, one accent #d2683f (ember) used for the single primary action and small highlights, never for large fills. Radii 12px on cards, 10px on controls. A type scale of four sizes at most; headings tight, body 15px with generous line height. Space on an 8px grid; more space between groups than within them. Every screen has one clear primary action and a visible hierarchy; secondary actions are quiet. Real copy in the user's domain, never lorem ipsum, never "Item 1". Show states the brief implies: empty, loading, error, success. Tables align numbers right in a mono face. Interactive means interactive: toggles toggle, tabs switch, forms validate, lists filter, counters count. Width-aware: works from 390px to 1280px. No emoji as icons. No gratuitous animation; a 150ms transition on hover and state is enough.

Quality bar: a designer at a good product company would sign off on it. If the brief is a comparison or a report, lead with the answer, then the evidence. If it is a tool, the first thing on screen is the thing the user came to do.`;
