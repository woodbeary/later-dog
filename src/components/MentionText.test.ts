import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MentionText } from "./MentionText";
import { DOG_COLORS } from "@/lib/mascot";

it("uses each bot's avatar palette and updates when its color changes", () => {
  for (const color of ["red", "blue"] as const) {
    const html = renderToStaticMarkup(createElement(MentionText, {
      text: "@Atlas @Juniper @everyone", everyone: true,
      peers: [{ name: "Atlas", color }, { name: "Juniper", color: "purple" }],
    }));
    expect(html).toContain(`style="--mention-color:${DOG_COLORS[color]}">@Atlas`);
    expect(html).toContain(`style="--mention-color:${DOG_COLORS.purple}">@Juniper`);
    expect(html).toContain('<span class="mention-highlight">@everyone</span>');
  }
});

it("decorates known names while preserving whitespace and escaping text", () => {
  const html = renderToStaticMarkup(createElement(MentionText, {
    text: "<script>\n@Atlas & @Ghost\n@Atlas", peers: [{ name: "Atlas" }],
  }));
  expect(html).toBe('&lt;script&gt;\n<span class="mention-highlight">@Atlas</span> &amp; @Ghost\n<span class="mention-highlight">@Atlas</span>');
});

it("leaves a name plain when no identity history exists or its peer is archived", () => {
  for (const peers of [[{ name: "Renamed" }], [{ name: "Atlas", hidden: true }]]) {
    expect(renderToStaticMarkup(createElement(MentionText, { text: "@Atlas", peers }))).toBe("@Atlas");
  }
});

const renamed = [{ id: "d1", name: "Tutor", formerNames: ["Study Helper"], color: "blue" as const }];

it("shows the current name and a face when displaying a message that used an earlier name", () => {
  const html = renderToStaticMarkup(createElement(MentionText, { text: "Thanks @Study Helper", peers: renamed, faces: true }));
  expect(html).toContain("data-mention-face");
  expect(html).toContain("@Tutor</span>");
  expect(html).not.toContain("Study Helper");
});

it("keeps exactly what was typed, with no face, inside the composer so the caret stays aligned", () => {
  const html = renderToStaticMarkup(createElement(MentionText, { text: "Thanks @Study Helper", peers: renamed }));
  expect(html).not.toContain("data-mention-face");
  expect(html).toContain("@Study Helper</span>");
});


it("leaves reused historical mentions plain while the composer still highlights the current owner", () => {
  const peers = [
    { id: "old", name: "Tutor", formerNames: ["Atlas"], color: "blue" as const },
    { id: "new", name: "Atlas", color: "red" as const },
  ];
  expect(renderToStaticMarkup(createElement(MentionText, { text: "@Atlas", peers, faces: true }))).toBe("@Atlas");
  expect(renderToStaticMarkup(createElement(MentionText, { text: "@Atlas", peers })))
    .toContain(`style="--mention-color:${DOG_COLORS.red}">@Atlas`);
});
