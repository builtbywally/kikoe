/**
 * A web card driven by voice: the words, and where they lead.
 */

import { describe, expect, it } from "vitest";
import { addressFor, browseAsk } from "../src/browse.js";

describe("browseAsk", () => {
  it("hears the browser verbs", () => {
    expect(browseAsk("go back")?.action).toBe("back");
    expect(browseAsk("Kikoe, go back a page.")?.action).toBe("back");
    expect(browseAsk("forward")?.action).toBe("forward");
    expect(browseAsk("reload the page")?.action).toBe("reload");
    expect(browseAsk("refresh it")?.action).toBe("reload");
    expect(browseAsk("zoom in")?.action).toBe("zoom-in");
    expect(browseAsk("make the page smaller")?.action).toBe("zoom-out");
    expect(browseAsk("go to github")).toEqual({ action: "go", url: "https://www.github.com" });
  });

  it("leaves other sentences alone", () => {
    expect(browseAsk("go back to marine")).toBeNull();
    expect(browseAsk("add a back button to the page")).toBeNull();
    expect(browseAsk("run the commerce project")).toBeNull();
  });
});

describe("addressFor", () => {
  it("turns a spoken place into an address", () => {
    expect(addressFor("github")).toBe("https://www.github.com");
    expect(addressFor("github.com slash anthropics")).toBe("https://github.com/anthropics");
    expect(addressFor("localhost 4800/checkout")).toBe("http://localhost:4800/checkout");
    expect(addressFor("localhost port 3000")).toBe("http://localhost:3000");
    expect(addressFor("port 5173")).toBe("http://localhost:5173");
    expect(addressFor("the best pizza in beirut")).toMatch(/google\.com\/search\?q=the%20best/);
  });
});
