import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCloudComputerTool } from "../../server/cloud-computer-tools.ts";
import type { AppConfig } from "../../server/config.ts";
import type { Target } from "../../server/laterdog/cloud-tabs.ts";
import { startFixtureSite } from "./fixture-site.ts";
import { headlessBrowser, type HeadlessBrowser } from "./no-vision.ts";

const cfg = { features: { pageTools: true } } as AppConfig;
const signal = new AbortController().signal;

describe.skipIf(!headlessBrowser.available())("page_open on the cloud computer's browser", () => {
  let chrome: HeadlessBrowser;
  let site: Awaited<ReturnType<typeof startFixtureSite>>;
  beforeAll(async () => { chrome = await headlessBrowser.start(); site = await startFixtureSite(); }, 30_000);
  afterAll(async () => { await site?.close(); await chrome?.stop(); });

  const pages = async () => ((await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json()) as Array<{ type: string; url: string }>)
    .filter((target) => target.type === "page").map((target) => target.url);

  it("opens a new tab, keeps the page that was open, and reports the tabs the way open_url does", async () => {
    const seen: Target[][] = [];
    const open = (path: string) => runCloudComputerTool(cfg, "fixture", "page_open", { url: `${site.origin}${path}` }, signal, (targets) => seen.push(targets), undefined, chrome.exec);
    const before = (await pages()).length;
    expect((await open("/shop")).isError).not.toBe(true);
    expect((await open("/shipping")).isError).not.toBe(true);
    const after = await pages();
    expect(after).toHaveLength(before + 2);
    expect(after).toEqual(expect.arrayContaining([`${site.origin}/shop`, `${site.origin}/shipping`]));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.at(-1)!.map((target) => target.url)).toEqual(expect.arrayContaining([`${site.origin}/shop`, `${site.origin}/shipping`]));
    const read = await runCloudComputerTool(cfg, "fixture", "page_read", {}, signal, undefined, undefined, chrome.exec);
    expect((read.content[0] as { text: string }).text).toContain("# Shipping policy");
  }, 60_000);
});
