import { describe, expect, it, vi } from "vitest";

import { closedViewerAction, transitionComputerControlLease } from "./computer-control";

const snap = (held: boolean) => ({ held, helpReason: null });

describe("computer/browser control transition ordering", () => {
  it("gates Electron before taking the server lease", async () => {
    const calls: string[] = [];
    await transitionComputerControlLease({
      action: "take",
      syncNativeBrowser: true,
      setNativeBrowserControl: async (held) => { calls.push(`native:${held}`); return true; },
      requestControl: async (action) => { calls.push(`server:${action}`); return snap(true); },
    });
    expect(calls).toEqual(["native:true", "server:take"]);
  });

  it("releases the server before clearing Electron", async () => {
    const calls: string[] = [];
    await transitionComputerControlLease({
      action: "release",
      syncNativeBrowser: true,
      setNativeBrowserControl: async (held) => { calls.push(`native:${held}`); return true; },
      requestControl: async (action) => { calls.push(`server:${action}`); return snap(false); },
    });
    expect(calls).toEqual(["server:release", "native:false"]);
  });

  it("never clears the private gate when the server did not release", async () => {
    const setNativeBrowserControl = vi.fn(async () => true);
    await expect(transitionComputerControlLease({
      action: "release",
      syncNativeBrowser: true,
      setNativeBrowserControl,
      requestControl: async () => snap(true),
    })).rejects.toThrow(/could not release/i);
    expect(setNativeBrowserControl).not.toHaveBeenCalled();
  });

  it("does not contact the server if the private take gate fails", async () => {
    const requestControl = vi.fn(async () => snap(true));
    await expect(transitionComputerControlLease({
      action: "take",
      syncNativeBrowser: true,
      setNativeBrowserControl: async () => false,
      requestControl,
    })).rejects.toThrow(/pause.*browser/i);
    expect(requestControl).not.toHaveBeenCalled();
  });

  it("skips the native browser step when the caller handles it", async () => {
    const setNativeBrowserControl = vi.fn(async () => true);
    await transitionComputerControlLease({
      action: "take",
      syncNativeBrowser: false,
      setNativeBrowserControl,
      requestControl: async () => snap(true),
    });
    expect(setNativeBrowserControl).not.toHaveBeenCalled();
  });
});

describe("what closing the live desktop window tells later.dog", () => {
  it("hands the step back only when the person pressed I'm done in the window", () => {
    expect(closedViewerAction({ open: false, contextId: "scout", done: true })).toEqual({ botId: "scout", action: "hand-back" });
  });

  it("only lets go of the screen when the window closed any other way, so the step stays theirs", () => {
    expect(closedViewerAction({ open: false, contextId: "scout" })).toEqual({ botId: "scout", action: "release" });
    expect(closedViewerAction({ open: false, contextId: "scout", done: false })).toEqual({ botId: "scout", action: "release" });
  });

  it("does nothing while the window is open, for a cloud job's window, or without a dog", () => {
    expect(closedViewerAction({ open: true, contextId: "scout", done: true })).toBeNull();
    expect(closedViewerAction({ open: false, contextId: "cloud-task:job-1", done: true })).toBeNull();
    expect(closedViewerAction({ open: false, contextId: null })).toBeNull();
  });
});
