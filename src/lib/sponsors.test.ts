import { describe, expect, it } from "vitest";

import { SPONSORS, SPONSOR_URL, sponsorLink, sponsorSlot, type Sponsor } from "./sponsors";

const acme: Sponsor = { name: "Acme", tagline: "Ships your dogs' work.", url: "https://acme.example/later-dog" };

describe("the Sponsored slot", () => {
  it("ships empty, so Apps shows no Sponsored section", () => {
    expect(SPONSORS).toEqual([]);
    expect(SPONSOR_URL).toBeNull();
    expect(sponsorSlot()).toEqual({ kind: "none" });
  });

  it("offers the spot once there is a sponsor page to send people to", () => {
    expect(sponsorSlot([], "https://later.dog/sponsor")).toEqual({ kind: "open", url: "https://later.dog/sponsor" });
  });

  it("shows the sponsors, with the sponsor page when there is one", () => {
    expect(sponsorSlot([acme], "https://later.dog/sponsor")).toEqual({ kind: "sponsors", sponsors: [acme], url: "https://later.dog/sponsor" });
    expect(sponsorSlot([acme], null)).toEqual({ kind: "sponsors", sponsors: [acme], url: null });
  });

  it("never links anywhere but a plain https page", () => {
    for (const url of ["", "  ", "http://acme.example", "javascript:alert(1)", "data:text/html,hi", "https://user:pass@acme.example", "acme.example", "file:///etc/passwd"]) {
      expect(sponsorLink(url), url).toBeNull();
      expect(sponsorSlot([{ ...acme, url }], url), url).toEqual({ kind: "none" });
    }
    expect(sponsorSlot([{ ...acme, url: "javascript:alert(1)" }, acme], "javascript:alert(1)")).toEqual({ kind: "sponsors", sponsors: [acme], url: null });
  });

  it("drops a sponsor with no name, and keeps only a local icon and a hex colour", () => {
    expect(sponsorSlot([{ ...acme, name: "  " }], null)).toEqual({ kind: "none" });
    const [kept] = (sponsorSlot([{ ...acme, icon: "/sponsors/acme.png", color: "#F60" }], null) as { sponsors: Sponsor[] }).sponsors;
    expect(kept).toEqual({ ...acme, icon: "/sponsors/acme.png", color: "#ff6600" });
    for (const icon of ["https://cdn.acme.example/logo.png", "//cdn.acme.example/logo.png", "javascript:alert(1)", "data:text/html,hi"]) {
      expect((sponsorSlot([{ ...acme, icon }], null) as { sponsors: Sponsor[] }).sponsors[0]!.icon, icon).toBeUndefined();
    }
    expect((sponsorSlot([{ ...acme, color: "red; background: url(x)" }], null) as { sponsors: Sponsor[] }).sponsors[0]!.color).toBeUndefined();
  });
});
