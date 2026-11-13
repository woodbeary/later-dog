// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WireExchange } from "../../shared/room-exchange";
import { TurnResultsBlock } from "./TurnResultsBlock";
import { ExchangeDetails } from "./QuietLines";

const PR = "https://github.com/example/repo/pull/7";
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.laterdog; vi.unstubAllGlobals(); });

const draw = (results: Parameters<typeof TurnResultsBlock>[0]["results"]) => act(async () => root.render(createElement(TurnResultsBlock, { results })));

it("shows nothing when a turn has no results", async () => {
  await draw(undefined);
  expect(host.innerHTML).toBe("");
  await draw({});
  expect(host.innerHTML).toBe("");
});

it("lists changed files, the pull request and the command count", async () => {
  await draw({
    files: [{ path: "src/a.ts", change: "edited" }, { path: "notes.md", change: "created" }],
    moreFiles: 3,
    links: [{ kind: "pull-request", label: "Fix login", url: PR }],
    commands: 4,
  });
  const files = host.querySelector("[data-turn-results-files]");
  expect(files?.querySelector("div")?.textContent).toBe("Changed 5 files");
  expect([...files!.querySelectorAll("li")].map((row) => row.textContent)).toEqual(["src/a.tsedited", "notes.mdcreated", "+3 more"]);
  expect(host.querySelector("[data-turn-results-commands]")?.textContent).toBe("Ran 4 commands");
  const link = host.querySelector<HTMLAnchorElement>("[data-turn-results-link]");
  expect(link?.textContent).toBe("Fix login");
  expect(link?.getAttribute("href")).toBe(PR);
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
});

it("opens the link through the app when it runs in the desktop app", async () => {
  const openExternal = vi.fn(async () => {});
  window.laterdog = { openExternal } as unknown as typeof window.laterdog;
  await draw({ links: [{ kind: "pull-request", label: "Fix login", url: PR }], commands: 1 });
  expect(host.querySelector("[data-turn-results-commands]")?.textContent).toBe("Ran 1 command");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => { host.querySelector("[data-turn-results-link]")!.dispatchEvent(click); });
  expect(click.defaultPrevented).toBe(true);
  expect(openExternal).toHaveBeenCalledWith(PR);
});

const exchange = (over: Partial<WireExchange>): WireExchange => ({
  id: "x", status: "completed", owner: { dog: "Clover", person: true }, from: "Clover", to: "Scout", request: "Check totals", reply: "They match", ...over,
});

it("shows the replying dog's results in a completed exchange, and nothing without them", async () => {
  await act(async () => root.render(createElement(ExchangeDetails, { id: "d", record: exchange({ results: { files: [{ path: "totals.csv", change: "deleted" }] } }) })));
  expect(host.querySelector("[data-turn-results-files]")?.textContent).toBe("Changed 1 filetotals.csvdeleted");
  await act(async () => root.render(createElement(ExchangeDetails, { id: "d", record: exchange({}) })));
  expect(host.querySelector("[data-turn-results]")).toBeNull();
});
