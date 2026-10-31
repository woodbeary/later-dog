import { describe, expect, it } from "vitest";
import { quickLookKind, quickLookWay } from "./quick-look";

describe("which files get a preview", () => {
  it("knows documents, spreadsheets and slides by their extension", () => {
    expect(quickLookKind("Report.PDF")).toBe("pdf");
    expect(quickLookKind("/home/dog/budget.xlsx")).toBe("xlsx");
    expect(quickLookKind("C:\\decks\\pitch.key")).toBe("key");
    expect(quickLookKind("notes.docx")).toBe("docx");
    expect(quickLookKind("photo.png")).toBeNull();
    expect(quickLookKind("script.sh")).toBeNull();
    expect(quickLookKind(".pdf")).toBeNull();
    expect(quickLookKind("README")).toBeNull();
  });

  it("uses the Mac's own viewer when the app offers it, the browser's for PDFs on the web, and nothing otherwise", () => {
    const mac = { previewFile: async () => true } as unknown as Window["laterdog"];
    const elsewhere = {} as Window["laterdog"];
    expect(quickLookWay("deck.pptx", mac)).toBe("native");
    expect(quickLookWay("paper.pdf", mac)).toBe("native");
    expect(quickLookWay("paper.pdf", undefined)).toBe("browser");
    expect(quickLookWay("deck.pptx", undefined)).toBeNull();
    expect(quickLookWay("paper.pdf", elsewhere)).toBeNull();
    expect(quickLookWay("photo.png", mac)).toBeNull();
  });
});
