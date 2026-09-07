import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOME = mkdtempSync(path.join(os.tmpdir(), "kikoe-runtime-"));
process.env.KIKOE_HOME = HOME;
process.env.KIKOE_CLAUDE_DIR = path.join(HOME, "claude");

let rt: typeof import("../src/runtime.js");
let mod: typeof import("../src/daemon.js");
let cfg: typeof import("../src/config.js");
let d: InstanceType<typeof import("../src/daemon.js").Daemon>;
let port = 0;

function get(
  p: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET" }, (res) => {
      let out = "";
      res.on("data", (c) => {
        out += c;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: out, headers: res.headers }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  rt = await import("../src/runtime.js");
  mod = await import("../src/daemon.js");
  cfg = await import("../src/config.js");
  d = new mod.Daemon({ audio: false, settings: { ...cfg.DEFAULTS, tts: "none", port: 0 } });
  port = 4900 + Math.floor(Math.random() * 200);
  await d.listen(port);
});
afterAll(async () => {
  await d.close();
});

describe("the artifact runtime", () => {
  it("turns a component file into a page with React, Babel and Tailwind from the allowlist", () => {
    const page = rt.wrapReact(
      `import React, { useState } from "react";
import { Check, X as Cross } from "lucide-react";
import { LineChart, Line } from "recharts";

export default function App() {
  const [n, setN] = useState(0);
  return <button className="px-4" onClick={() => setN(n + 1)}><Check /> {n}</button>;
}`,
      "counter",
    );
    expect(page).toContain("react.production.min.js");
    expect(page).toContain("babel.min.js");
    expect(page).toContain("cdn.tailwindcss.com");
    expect(page).toContain("lucide-react");
    expect(page).toContain("Recharts.min.js");
    expect(page).not.toMatch(/^\s*import /m);
    expect(page).toContain("const { Check, X: Cross } = LucideReact;");
    expect(page).toContain("const { LineChart, Line } = Recharts;");
    expect(page).toContain("function App()");
    expect(page).toContain("React.createElement(App)");
    expect(page).toContain("<title>counter</title>");
  });

  it("never declares a React hook twice, however the artifact imports it", () => {
    // Every artifact ever written opens with this line. The runtime already
    // destructures the hooks before the code runs, so rewriting the import
    // into a second `const { useState } = React` is a redeclaration: a
    // SyntaxError that blanks the card with no clue why.
    const page = rt.wrapReact(
      `import React, { useState, useMemo, useCallback } from "react";
export default function App() {
  const [n] = useState(0);
  return <p>{n}</p>;
}`,
      "hooks",
    );
    const declared = [...page.matchAll(/const\s*\{([^}]*)\}\s*=\s*React;/g)].flatMap((m) =>
      m[1]!.split(",").map((s) => s.trim().split(":")[0]!.trim()),
    );
    expect(declared).toContain("useState");
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("gives lucide the lower-case React global its UMD actually reads", () => {
    // lucide's bundle ends `i(a.LucideReact={}, a.react)` — lower case. React's
    // UMD only defines `window.React`, so without the alias every artifact with
    // an icon dies on "cannot read forwardRef of undefined" and the card is
    // blank for a reason that looks like the artifact's fault.
    const page = rt.wrapReact(
      'import { Activity } from "lucide-react";\nexport default function App(){return <Activity/>}',
      "icons",
    );
    expect(page).toContain("window.react=window.React");
    // and the alias has to be in place before the bundle that needs it
    expect(page.indexOf("window.react=window.React")).toBeLessThan(page.indexOf("lucide-react@"));
  });

  it("still takes a React name the runtime does not pre-declare", () => {
    const page = rt.wrapReact(
      'import React, { useTransition } from "react";\nexport default function App(){return <p/>}',
      "t",
    );
    expect(page).toContain("const { useTransition } = React;");
  });

  it("handles an arrow default export, a fence, and an unknown import", () => {
    const page = rt.wrapReact(
      '```jsx\nimport x from "nowhere";\nconst Card = () => <div/>;\nexport default () => <Card/>;\n```',
      "t",
    );
    expect(page).toContain("const __KikoeRoot = () => <Card/>;");
    expect(page).toContain("React.createElement(__KikoeRoot)");
    expect(page).toContain("import from nowhere is not available");
    expect(page).not.toContain("```");
    expect(rt.stripFences("```html\n<p>x</p>\n```")).toBe("<p>x</p>");
    expect(rt.stripFences("<p>x</p>")).toBe("<p>x</p>");
  });

  it("serves a page by id with its own content policy, and nothing else", async () => {
    const html = d.board.add({ kind: "html", title: "h", body: "<h1>hi</h1>", repo: "kik" });
    const react = d.board.add({
      kind: "react",
      title: "r",
      body: "export default function App(){return <p>r</p>}",
      repo: "kik",
    });
    const note = d.board.add({ kind: "note", title: "n", body: "no page", repo: "kik" });
    const a = await get(`/artifact/${html.id}`);
    expect(a.status).toBe(200);
    expect(a.headers["content-type"]).toContain("text/html");
    expect(String(a.headers["content-security-policy"])).toContain("cdnjs.cloudflare.com");
    expect(String(a.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(a.body).toContain("data-kikoe-kit");
    expect(a.body).toContain("<h1>hi</h1>");
    const b = await get(`/artifact/${react.id}`);
    expect(b.status).toBe(200);
    expect(b.body).toContain("babel.min.js");
    expect((await get(`/artifact/${note.id}`)).status).toBe(404);
    expect((await get("/artifact/nope")).status).toBe(404);
    // the id opens one page; the api still wants a token
    expect((await get("/state")).status).toBe(401);
  });
});
