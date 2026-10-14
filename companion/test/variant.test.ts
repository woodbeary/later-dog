import { describe, expect, it } from "vitest";

import { companionDefaults } from "../src/variant.ts";

describe("which companion this is", () => {
  it("is the release companion unless the app itself says it is Dev", () => {
    expect(companionDefaults({}, "/home")).toEqual({ companionPort: 8810, controlPort: 8811, dataDir: "/home/.laterdog-companion" });
    expect(companionDefaults({ LATERDOG_APP_VARIANT: "dev" }, "/home")).toEqual({ companionPort: 8910, controlPort: 8909, dataDir: "/home/.laterdog-dev/companion" });
  });

  it("ignores a stray LATERDOG_VARIANT, so the release never loses its paired phones", () => {
    expect(companionDefaults({ LATERDOG_VARIANT: "dev" }, "/home")).toEqual({ companionPort: 8810, controlPort: 8811, dataDir: "/home/.laterdog-companion" });
  });
});
