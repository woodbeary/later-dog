import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { PhonePairingDialog } from "./PhonePairingDialog";

const render = (open: boolean) => {
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {}, laterdog: undefined });
  try {
    return renderToStaticMarkup(createElement(PhonePairingDialog, { open, onClose: () => {} }));
  } finally {
    vi.unstubAllGlobals();
  }
};

it("opens the pairing flow in a dialog that can be closed", () => {
  const html = render(true);
  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-label="Connect your phone"');
  expect(html).toContain("from another device");
  expect(html).toContain('aria-label="Close"');
});

it("is not drawn while closed", () => {
  expect(render(false)).toBe("");
});
