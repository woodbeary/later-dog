import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_DEFAULT_SCRIPT } from "../src/browser-default";
import { MINUTE } from "../src/idle";
import { OWNER_KEY, apiRequest, body, world } from "./fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the desktop's web browser", () => {
  it("is set to Chromium as the dog's user once a fresh boot is ready", async () => {
    const w = await world();
    const created = await w.fetch(apiRequest("POST", "/v1/computers", OWNER_KEY, { body: {} }));
    const { computer } = await body(created);
    await w.advance(MINUTE);
    const current = await body(await w.fetch(apiRequest("GET", `/v1/computers/${computer.id}`, OWNER_KEY)));
    expect(current.computer.state).toBe("running");
    const setups = w.containers.get(computer.id)!.execs.filter((call) => call.cmd.includes(BROWSER_DEFAULT_SCRIPT));
    expect(setups).toHaveLength(1);
    expect(setups[0]!.options?.user).toBe("1000:1000");
  });

  it("writes helpers.rc and the Chromium helper only where missing, so a dog's own choice stands", () => {
    expect(BROWSER_DEFAULT_SCRIPT).toContain(
      "[ -s /home/dog/.config/xfce4/helpers.rc ] || printf 'WebBrowser=custom-WebBrowser\\n' > /home/dog/.config/xfce4/helpers.rc",
    );
    expect(BROWSER_DEFAULT_SCRIPT).toContain(
      "[ -s /home/dog/.local/share/xfce4/helpers/custom-WebBrowser.desktop ] || printf '%s\\n' '[Desktop Entry]'",
    );
    expect(BROWSER_DEFAULT_SCRIPT).toContain("'X-XFCE-Category=WebBrowser'");
    expect(BROWSER_DEFAULT_SCRIPT).toContain(`'X-XFCE-CommandsWithParameter=/usr/bin/chromium "%s"'`);
  });
});
