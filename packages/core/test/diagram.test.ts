import { diagramToSvg, parseDiagram } from "@kikoe/core";
import { describe, expect, it } from "vitest";

describe("the diagram language", () => {
  it("parses chains, marks, and notes", () => {
    const d = parseDiagram(
      "fetch -> retry x3 -> give up\n*retry x3\nnote: a fourth attempt never helped\n# a comment",
    );
    expect(d.nodes).toEqual(["fetch", "retry x3", "give up"]);
    expect(d.edges).toEqual([
      ["fetch", "retry x3"],
      ["retry x3", "give up"],
    ]);
    expect([...d.current]).toEqual(["retry x3"]);
    expect(d.notes).toEqual(["a fourth attempt never helped"]);
  });

  it("renders SVG that scales, uses the theme colour, and escapes text", () => {
    const svg = diagramToSvg("a <b> -> c\nc -> a");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0');
    expect(svg).toContain("currentColor");
    expect(svg).toContain("a &lt;b&gt;");
    expect(svg).not.toContain("<script");
    expect(diagramToSvg("")).toBe("");
  });

  it("lays out left to right by longest path", () => {
    const svg = diagramToSvg("a -> b\nb -> c\na -> c");
    const xs = [...svg.matchAll(/<rect x="(\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]));
    expect(xs.length).toBe(3);
    expect(xs[0]).toBeLessThan(xs[1]!);
    expect(xs[1]).toBeLessThan(xs[2]!);
  });
});
