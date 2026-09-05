/**
 * A small diagram language for the board, rendered to SVG here so the agent
 * never places a coordinate and every diagram shares one look.
 *
 *   fetch -> retry x3 -> give up
 *   retry x3 -> backoff 200, 800, 3200 ms
 *   *retry x3
 *   note: a fourth attempt never helped
 *
 * One edge per line with `->` between nodes; a node is any text; a line
 * starting with `*` marks a node as the current one (ember); `note:` adds a
 * caption; `label: a -> b: text` is not supported, keep it simple. Layout is
 * layered left to right by longest path, rows within a layer in order of
 * first appearance. Output uses currentColor for strokes and text so the
 * Room's theme colours it.
 */

export interface Diagram {
  nodes: string[];
  edges: Array<[string, string]>;
  current: Set<string>;
  notes: string[];
}

export function parseDiagram(text: string): Diagram {
  const nodes: string[] = [];
  const edges: Array<[string, string]> = [];
  const current = new Set<string>();
  const notes: string[] = [];
  const add = (n: string) => {
    const name = n.trim();
    if (name && !nodes.includes(name)) nodes.push(name);
    return name;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.toLowerCase().startsWith("note:")) {
      notes.push(line.slice(5).trim());
      continue;
    }
    if (line.startsWith("*")) {
      current.add(add(line.slice(1)));
      continue;
    }
    const parts = line.split(/\s*(?:->|→|=>)\s*/);
    if (parts.length === 1) {
      add(parts[0]!);
      continue;
    }
    for (let i = 0; i + 1 < parts.length; i++) {
      const a = add(parts[i]!);
      const b = add(parts[i + 1]!);
      if (a && b) edges.push([a, b]);
    }
  }
  return { nodes, edges, current, notes };
}

/** Longest-path layering, cycles broken at the back edge. */
function layers(d: Diagram): Map<string, number> {
  const depth = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of d.nodes) out.set(n, []);
  for (const [a, b] of d.edges) out.get(a)?.push(b);
  const visiting = new Set<string>();
  const visit = (n: string, dep: number) => {
    if (visiting.has(n)) return;
    if ((depth.get(n) ?? -1) >= dep) return;
    depth.set(n, dep);
    visiting.add(n);
    for (const m of out.get(n) ?? []) visit(m, dep + 1);
    visiting.delete(n);
  };
  const targets = new Set(d.edges.map((e) => e[1]));
  for (const n of d.nodes) if (!targets.has(n)) visit(n, 0);
  for (const n of d.nodes) if (!depth.has(n)) visit(n, 0);
  return depth;
}

const FONT = "IBM Plex Mono, ui-monospace, Consolas, monospace";
const PAD_X = 16;
const H = 44;
const GAP_X = 44;
const GAP_Y = 18;
const CHAR = 7.4;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The diagram as inline SVG. Empty string for an empty diagram. */
export function diagramToSvg(text: string): string {
  const d = parseDiagram(text);
  if (!d.nodes.length) return "";
  const depth = layers(d);
  const cols = new Map<number, string[]>();
  for (const n of d.nodes) {
    const c = depth.get(n) ?? 0;
    if (!cols.has(c)) cols.set(c, []);
    cols.get(c)!.push(n);
  }
  const width = (n: string) => Math.max(72, Math.round(n.length * CHAR) + PAD_X * 2);
  const colW = new Map<number, number>();
  for (const [c, ns] of cols) colW.set(c, Math.max(...ns.map(width)));
  const rows = Math.max(...[...cols.values()].map((ns) => ns.length));
  const totalH = rows * H + (rows - 1) * GAP_Y;
  // positions
  const pos = new Map<string, { x: number; y: number; w: number }>();
  let x = 0;
  const maxCol = Math.max(...cols.keys());
  for (let c = 0; c <= maxCol; c++) {
    const ns = cols.get(c) ?? [];
    const w = colW.get(c) ?? 72;
    const stackH = ns.length * H + (ns.length - 1) * GAP_Y;
    let y = (totalH - stackH) / 2;
    for (const n of ns) {
      pos.set(n, { x, y, w });
      y += H + GAP_Y;
    }
    x += w + GAP_X;
  }
  const totalW = x - GAP_X;
  const noteH = d.notes.length ? d.notes.length * 18 + 10 : 0;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW + 8} ${totalH + noteH + 8}" width="${totalW + 8}" height="${totalH + noteH + 8}" font-family="${FONT}" font-size="12">`,
  );
  parts.push(
    `<defs><marker id="k-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`,
  );
  parts.push(`<g transform="translate(4 4)">`);
  for (const [a, b] of d.edges) {
    const pa = pos.get(a);
    const pb = pos.get(b);
    if (!pa || !pb) continue;
    const forward = pb.x > pa.x;
    const x1 = forward ? pa.x + pa.w : pa.x + pa.w / 2;
    const y1 = forward ? pa.y + H / 2 : pa.y + H;
    const x2 = forward ? pb.x : pb.x + pb.w / 2;
    const y2 = forward ? pb.y + H / 2 : pb.y;
    const d1 = forward
      ? `M${x1} ${y1} C${x1 + GAP_X / 2} ${y1} ${x2 - GAP_X / 2} ${y2} ${x2 - 1} ${y2}`
      : `M${x1} ${y1} v${GAP_Y / 2 + 6} H${x2} V${y2 - 1}`;
    parts.push(
      `<path d="${d1}" fill="none" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.4" stroke-dasharray="${forward ? "" : "3 4"}" marker-end="url(#k-arrow)"/>`,
    );
  }
  for (const n of d.nodes) {
    const p = pos.get(n)!;
    const cur = d.current.has(n);
    parts.push(
      `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${H}" rx="8" fill="none" stroke="${cur ? "#d2683f" : "currentColor"}" stroke-opacity="${cur ? 1 : 0.7}" stroke-width="${cur ? 1.6 : 1.2}"/>`,
    );
    parts.push(
      `<text x="${p.x + p.w / 2}" y="${p.y + H / 2 + 4}" text-anchor="middle" fill="currentColor">${esc(n)}</text>`,
    );
  }
  d.notes.forEach((note, i) => {
    parts.push(
      `<text x="${totalW / 2}" y="${totalH + 22 + i * 18}" text-anchor="middle" fill="currentColor" fill-opacity="0.55" font-size="11">${esc(note)}</text>`,
    );
  });
  parts.push("</g></svg>");
  return parts.join("");
}
