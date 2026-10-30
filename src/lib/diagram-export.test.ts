import { describe, expect, it } from "vitest";
import { exportableDiagram, sizedSvg, svgSize } from "./diagram-export";

describe("saving a diagram as a picture", () => {
  it("draws the saved copy in the light theme with plain text labels, after any front matter", () => {
    const directive = '%%{init: {"theme":"default","htmlLabels":false,"flowchart":{"htmlLabels":false}}}%%\n';
    expect(exportableDiagram("flowchart LR\n  A --> B")).toBe(`${directive}flowchart LR\n  A --> B`);
    expect(exportableDiagram("---\ntitle: Sales\n---\npie\n  \"A\": 1")).toBe(`---\ntitle: Sales\n---\n${directive}pie\n  "A": 1`);
  });

  it("reads the picture's size from its view box, or its width and height", () => {
    expect(svgSize('<svg id="m" width="100%" viewBox="-8 -8 416.5 230" style="max-width: 416px;">')).toEqual({ width: 416.5, height: 230 });
    expect(svgSize('<svg width="320px" height="200">')).toEqual({ width: 320, height: 200 });
    expect(svgSize("<svg>")).toEqual({ width: 800, height: 600 });
  });

  it("gives the picture a fixed size so it draws at full resolution", () => {
    expect(sizedSvg('<svg id="m" width="100%" style="max-width: 416px;" viewBox="0 0 416 230"><g/></svg>', { width: 416, height: 230 }))
      .toBe('<svg id="m" viewBox="0 0 416 230" width="416" height="230"><g/></svg>');
  });
});
