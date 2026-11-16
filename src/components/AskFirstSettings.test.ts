// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), rules: [] as string[] }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: { config: { profile: { name: "", email: "", askFirst: fixture.rules } } }, dispatch: fixture.dispatch }),
}));

const { AskFirstGroup } = await import("./AskFirstSettings");

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  fixture.rules = ["Buying anything"];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = () => act(() => root.render(createElement(AskFirstGroup)));
const settle = () => act(async () => { for (let round = 0; round < 5; round += 1) await Promise.resolve(); });
const type = (value: string) => {
  const input = host.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("Ask first in Settings", () => {
  it("says above the person's own rules what every dog always asks about", () => {
    render();
    expect(host.querySelector("[data-always-asks]")?.textContent).toMatch(/^Whatever its approval setting, every dog asks you before it pushes code without running its checks, .* pays or moves money from a connected app, or deletes something or changes who can see it in a connected app, unless you chose Always on that card; it goes by how a command is written, so it catches slips, not a dog set on getting around it\.$/);
  });

  it("lists the person's rules and adds a new one", async () => {
    fixture.api.mockResolvedValue({ profile: { name: "", email: "", askFirst: ["Buying anything", "Sending email to anyone new"] } });
    render();
    expect([...host.querySelectorAll("[data-ask-first-rule]")].map((row) => row.textContent)).toEqual(["Buying anything"]);
    type("  Sending email to anyone new ");
    act(() => host.querySelector("form")!.requestSubmit());
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PUT", body: JSON.stringify({ profile: { askFirst: ["Buying anything", "Sending email to anyone new"] } }) }));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "profileSaved", profile: { askFirst: ["Buying anything", "Sending email to anyone new"] } });
    expect(host.querySelector("input")!.value).toBe("");
  });

  it("doesn't save a rule it already has", async () => {
    render();
    type("buying ANYTHING");
    act(() => host.querySelector("form")!.requestSubmit());
    await settle();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("removes a rule, and says so when saving fails", async () => {
    fixture.api.mockRejectedValue(new Error("offline"));
    render();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove “Buying anything”"]')!.click());
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ body: JSON.stringify({ profile: { askFirst: [] } }) }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't save. Try again.");
  });
});
