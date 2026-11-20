import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCloudComputerTool } from "../../server/cloud-computer-tools.ts";
import type { AppConfig } from "../../server/config.ts";
import { MAX_TABS_PER_COMPUTER } from "../../server/laterdog/cloud-tabs.ts";
import { TabKeeper } from "../../server/laterdog/tab-keeper.ts";
import { startFixtureSite } from "./fixture-site.ts";
import { headlessBrowser, type HeadlessBrowser } from "./no-vision.ts";

const cfg = { features: { pageTools: true } } as AppConfig;
const signal = new AbortController().signal;
const dog = { botId: "dog", threadId: "task" };

describe.skipIf(!headlessBrowser.available())("tabs on the cloud computer's browser", () => {
  let chrome: HeadlessBrowser;
  let site: Awaited<ReturnType<typeof startFixtureSite>>;
  let dir: string;
  beforeAll(async () => { chrome = await headlessBrowser.start(); site = await startFixtureSite(); dir = mkdtempSync(join(tmpdir(), "page-tabs-")); }, 30_000);
  afterAll(async () => { await site?.close(); await chrome?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  const pages = async () => ((await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json()) as Array<{ type: string; url: string }>)
    .filter((target) => target.type === "page").map((target) => target.url);
  const keeper = () => new TabKeeper({
    file: join(dir, `ledger-${Math.random().toString(36).slice(2)}.json`),
    run: (_boxId, command) => chrome.exec(command, signal),
    thread: () => ({ exists: true, busy: false, closed: false, lastActiveAt: Date.now() }),
    control: () => ({ held: false, epoch: 0 }),
  });

  it("opens page after page in the dog's one tab, beside it only when asked, and holds the cap", async () => {
    const tabs = keeper();
    const call = (name: string, args: Record<string, unknown>) => runCloudComputerTool(cfg, "fixture", name, args, signal, tabs.watch(dog, "fixture"), undefined, chrome.exec);
    const before = (await pages()).length;
    expect((await call("page_open", { url: `${site.origin}/shop` })).isError).not.toBe(true);
    expect((await call("page_open", { url: `${site.origin}/shipping` })).isError).not.toBe(true);
    expect((await call("open_url", { url: `${site.origin}/contact` })).isError).not.toBe(true);
    expect(await pages()).toEqual([`${site.origin}/contact`, ...Array(Math.max(0, before - 1)).fill(expect.any(String))]);
    const read = await call("page_read", {});
    expect((read.content[0] as { text: string }).text).toContain("Contact");
    const beside = await call("page_open", { url: `${site.origin}/shipping`, new_tab: true });
    expect(beside.isError).not.toBe(true);
    expect((await pages()).slice(0, 2)).toEqual([`${site.origin}/shipping`, `${site.origin}/contact`]);
    for (const n of [1, 2, 3, 4, 5]) {
      await call("open_url", { url: `${site.origin}/shop?n=${n}`, new_tab: true });
      expect((await pages()).length).toBeLessThanOrEqual(MAX_TABS_PER_COMPUTER);
    }
    expect((await pages())[0]).toBe(`${site.origin}/shop?n=5`);
    await tabs.turnEnded("task");
    expect(await pages()).toEqual([`${site.origin}/shop?n=5`]);
  }, 90_000);

  it("leaves a page the dog was asked to keep open when its turn ends", async () => {
    const tabs = keeper();
    const call = (name: string, args: Record<string, unknown>) => runCloudComputerTool(cfg, "fixture", name, args, signal, tabs.watch(dog, "fixture"), undefined, chrome.exec);
    await call("open_url", { url: `${site.origin}/shipping`, new_tab: true, keep_open: true });
    await call("open_url", { url: `${site.origin}/shop`, new_tab: true });
    await call("open_url", { url: `${site.origin}/contact` });
    await tabs.turnEnded("task");
    expect((await pages()).sort()).toEqual([`${site.origin}/contact`, `${site.origin}/shipping`]);
  }, 60_000);
});
