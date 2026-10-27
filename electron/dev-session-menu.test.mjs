import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { EARLIER_CODE, RESTART_CODE, SWITCH_CODE, devSessionItems, quitWithCode } from "./dev-session-menu.mjs";

describe("the later.dog Dev app menu", () => {
  it("adds nothing outside a later.dog Dev app session", () => {
    expect(devSessionItems({}, () => {}, "later.dog Dev")).toEqual([]);
    expect(devSessionItems({ LATERDOG_DEV_SESSION: "0" }, () => {}, "later.dog Dev")).toEqual([]);
  });

  it("restarts the latest code or opens an earlier version", () => {
    const codes = [];
    const items = devSessionItems({ LATERDOG_DEV_SESSION: "1" }, (code) => codes.push(code), "later.dog Dev");
    expect(items.map((item) => item.label ?? item.type)).toEqual(["separator", "Restart later.dog Dev", "Open an Earlier Version…"]);
    for (const item of items) item.click?.();
    expect(codes).toEqual([RESTART_CODE, EARLIER_CODE]);
  });

  it("says which earlier version is running and offers the way back", () => {
    const codes = [];
    const items = devSessionItems({ LATERDOG_DEV_SESSION: "1", LATERDOG_DEV_SESSION_VERSION: "today at 9:02 AM" }, (code) => codes.push(code), "later.dog Dev");
    expect(items.map((item) => [item.label ?? item.type, item.enabled ?? true])).toEqual([
      ["separator", true],
      ["Running the code from today at 9:02 AM", false],
      ["Back to the Latest Code", true],
      ["Open an Earlier Version…", true],
    ]);
    items[2].click();
    expect(codes).toEqual([RESTART_CODE]);
  });

  it("switches between the later.dog Cloud chats and this Mac's Dev dogs", () => {
    const codes = [];
    const onHome = devSessionItems({ LATERDOG_DEV_SESSION: "1", LATERDOG_DEV_WORKSPACE: "home", LATERDOG_DEV_HOME_AVAILABLE: "1" }, (code) => codes.push(code), "later.dog Dev");
    expect(onHome.slice(3).map((item) => [item.label ?? item.type, item.enabled ?? true])).toEqual([
      ["separator", true],
      ["Showing your later.dog Cloud chats", false],
      ["Switch to This Mac's Dev Dogs", true],
    ]);
    onHome.at(-1).click();
    const onMac = devSessionItems({ LATERDOG_DEV_SESSION: "1", LATERDOG_DEV_HOME_AVAILABLE: "1" }, (code) => codes.push(code), "later.dog Dev");
    expect(onMac.slice(3).map((item) => item.label ?? item.type)).toEqual(["separator", "Switch to My later.dog Cloud"]);
    onMac.at(-1).click();
    expect(codes).toEqual([SWITCH_CODE, SWITCH_CODE]);
    expect(devSessionItems({ LATERDOG_DEV_SESSION: "1" }, () => {}, "later.dog Dev")).toHaveLength(3);
  });

  it("quits through the normal shutdown and only then exits with the chosen code", () => {
    const app = new EventEmitter();
    const steps = [];
    app.quit = () => steps.push("quit");
    app.exit = (code) => steps.push(`exit ${code}`);
    quitWithCode(app, EARLIER_CODE);
    expect(steps).toEqual(["quit"]);
    let prevented = false;
    app.emit("will-quit", { preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(steps).toEqual(["quit", `exit ${EARLIER_CODE}`]);
    app.emit("will-quit", { preventDefault: () => {} });
    expect(steps).toHaveLength(2);
  });
});
