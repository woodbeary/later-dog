import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { desktopPlan, runDesktop } from "./dev-desktop.mjs";

const SESSION = "/Users/jacob/.laterdog-dev-tools/my-home.session.json";

describe("later.dog Dev on the person's Cloud", () => {
  it("connects this Mac and sends server saves to the home, next to the window", () => {
    const plan = desktopPlan({ env: { LATERDOG_DEV_HOME_SESSION: SESSION }, home: "/Users/jacob", root: "/r", node: "/n" });
    const scripts = plan.services.map((service: { args: string[]; optional?: boolean }) => ({ script: service.args[0], args: service.args.slice(1), optional: service.optional === true }));
    expect(scripts).toEqual([
      { script: join("/r", "scripts/dev-home-proxy.mjs"), args: [SESSION, expect.any(String)], optional: false },
      { script: join("/r", "node_modules/vite/bin/vite.js"), args: expect.any(Array), optional: false },
      { script: join("/r", "scripts/dev-mac.mjs"), args: [SESSION, join("/Users/jacob", ".laterdog-dev")], optional: true },
      { script: join("/r", "scripts/dev-home.mjs"), args: ["watch", "--session", SESSION], optional: true },
    ]);
  });

  it("keeps the window open when an optional helper stops, and stops when a needed one does", async () => {
    const children: (EventEmitter & { kill: () => void; file: string })[] = [];
    const spawnProcess = (file: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { file: args[0] ?? file, kill: () => { setTimeout(() => child.emit("close", null, "SIGTERM"), 0); } });
      children.push(child);
      return child;
    };
    const plan = {
      root: "/r", env: {}, ports: [], serverUrl: "http://127.0.0.1:1", readyUrl: "http://127.0.0.1:1/ready", uiUrl: "http://127.0.0.1:2", supervisorUrl: null, homeSession: SESSION,
      services: [{ file: "/n", args: ["proxy"] }, { file: "/n", args: ["mac"], optional: true }],
      electron: { file: "/e", args: [] },
    };
    const signals = new EventEmitter();
    const running = runDesktop(plan, { spawnProcess: spawnProcess as never, assertPorts: async () => {}, waitReady: async () => {}, signals: signals as never });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(children.map((child) => child.file)).toEqual(["proxy", "mac", "/e"]);
    children[1]!.emit("close", 1, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    let finished = false;
    void running.then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(finished).toBe(false);
    children[0]!.emit("close", 1, null);
    expect(await running).toBe(1);
  });
});
