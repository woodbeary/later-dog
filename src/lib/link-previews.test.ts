import { describe, expect, it } from "vitest";
import { linkHost, previewLinks } from "./link-previews";

describe("links worth a preview", () => {
  it("takes the first two web pages a reply links to, plain or in Markdown", () => {
    expect(previewLinks("Try [Blue Bottle](https://bluebottlecoffee.com/cafes) or https://www.tartine.com/, then https://third.example/.")).toEqual([
      "https://bluebottlecoffee.com/cafes",
      "https://www.tartine.com/",
    ]);
  });

  it("skips pictures, files, code and repeats", () => {
    const text = "![cup](https://x.example/cup.png) see `https://code.example/a` and\n```\nhttps://code.example/b\n```\nhttps://x.example/report.pdf https://ok.example/page https://ok.example/page";
    expect(previewLinks(text)).toEqual(["https://ok.example/page"]);
    expect(previewLinks("http://plain.example/ is not https")).toEqual([]);
  });

  it("names a link by its host", () => {
    expect(linkHost("https://www.tartine.com/menu")).toBe("tartine.com");
  });
});
