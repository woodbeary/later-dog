import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDog, duplicateProfileFor, initialState, reducer, StoreProvider, useStore, type Action, type Bot } from "./store";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

// Capture the real command handler without mounting live event effects.
function mount(request: typeof fetch) {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  return dispatch;
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("createDog", () => {
  const bot = { id: "created", name: "Scout", messages: [] };

  it("creates a dog with one bare request when nothing is chosen", async () => {
    const request = vi.fn().mockResolvedValue({ bot });
    expect(await createDog({}, request)).toEqual({ bot });
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/bots", { method: "POST" });
  });

  it("sends the name and purpose trimmed, and the host model with requireAvailableModel", async () => {
    const request = vi.fn().mockResolvedValue({ bot });
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    await createDog({ name: " Scout ", title: " Trips ", modelSelection }, request);
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({ name: "Scout", title: "Trips", modelSelection, requireAvailableModel: true });
  });

  it("leaves blank fields to the server's own defaults", async () => {
    const request = vi.fn().mockResolvedValue({ bot });
    await createDog({ name: "  ", title: "" }, request);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/bots", { method: "POST" });
  });

  it("creates directly in the selected team in the one POST", async () => {
    const request = vi.fn().mockResolvedValue({ bot: { ...bot, section: "Studio" } });
    const created = await createDog({ section: "Studio" }, request);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/bots", { method: "POST", body: JSON.stringify({ section: "Studio" }) });
    expect(created.bot.section).toBe("Studio");
  });

  it("creates a restricted dog already restricted; everyone is the default and is not sent", async () => {
    const request = vi.fn().mockResolvedValue({ bot });
    await createDog({ visibility: "admins" }, request);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/bots", { method: "POST", body: JSON.stringify({ visibility: "admins" }) });
    const open = vi.fn().mockResolvedValue({ bot });
    await createDog({ visibility: "everyone" }, open);
    expect(open).toHaveBeenCalledExactlyOnceWith("/api/bots", { method: "POST" });
  });

  it("surfaces a failed creation as is", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(createDog({ name: "Scout" }, request)).rejects.toThrow("offline");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("duplicateProfileFor", () => {
  it("keeps the source's breed and colour along with its instructions", () => {
    const source = { id: "rex", name: "Rex", title: "Trips", description: "", soul: "Be brief.", notifications: true, color: "red", mascotBody: "beagle", messages: [] } as unknown as Bot;
    expect(duplicateProfileFor(source)).toMatchObject({ name: "Rex copy", title: "Trips", soul: "Be brief.", color: "red", mascotBody: "beagle" });
  });
});

describe("shared bot creation guard", () => {
  const bot = { id: "created", name: "Scout", messages: [] };

  it.each([false, true])("blocks duplicates across dismissal until creation settles; the hello follows and may fail (%s)", async (helloFails) => {
    const post = deferred();
    const hello = deferred();
    const request = vi.fn<typeof fetch>().mockReturnValueOnce(post.promise).mockReturnValueOnce(hello.promise).mockResolvedValue(response({ bot }));
    const dispatch = mount(request);
    const onCreated = vi.fn();
    const onError = vi.fn();
    dispatch({ type: "newBot", name: "Scout", title: "Trips", onCreated, onError });
    dispatch({ type: "toggleNewBot", open: false });
    dispatch({ type: "toggleNewBot", open: true });
    dispatch({ type: "newBot" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toEqual({ name: "Scout", title: "Trips" });
    post.resolve(response({ bot }));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![0]).toBe("/api/bots/created/hello");
    expect(request.mock.calls[1]![1]?.method).toBe("POST");
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(bot);
    hello.resolve(response(helloFails ? { error: "guests cannot introduce a dog" } : { ok: true }, helloFails ? 403 : 200));
    await flush();
    expect(onError).not.toHaveBeenCalled();
    dispatch({ type: "newBot" });
    await flush();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("releases the guard after POST failure so a fresh attempt can succeed", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(response({ bot }));
    const dispatch = mount(request);
    const onError = vi.fn();
    const onCreated = vi.fn();
    dispatch({ type: "newBot", onError, onCreated });
    dispatch({ type: "newBot" });
    await flush();
    expect(request).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("offline");
    expect(onCreated).not.toHaveBeenCalled();
    dispatch({ type: "newBot", onCreated });
    await flush();
    expect(onCreated).toHaveBeenCalledOnce();
  });
});

describe("setup navigation", () => {
  it.each([false, true])("preserves the current selection only for nested team creation (%s)", preserveSelection => {
    const bot = { id: "created", name: "Scout", messages: [] } as unknown as Bot;
    const state = { ...initialState, activeView: "team-map" as const, selectedId: "existing" };
    const next = reducer(state, { type: "botAdded", bot, preserveSelection });
    expect(next.bots).toContain(bot);
    expect(next.activeView).toBe(preserveSelection ? "team-map" : "chat");
    expect(next.selectedId).toBe(preserveSelection ? "existing" : "created");
    expect(reducer(state, { type: "botAdded", bot })).toMatchObject({ activeView: "chat", selectedId: "created" });
  });

  it("keeps creation pending through close/reopen until the request settles", () => {
    const pending = reducer(initialState, { type: "botCreationPending", on: true });
    const closed = reducer(pending, { type: "toggleNewBot", open: false });
    const reopened = reducer(closed, { type: "toggleNewBot", open: true });
    expect(reopened).toMatchObject({ newBotOpen: true, botCreationPending: true });
    expect(reducer(reopened, { type: "botCreationPending", on: false })).toMatchObject({ newBotOpen: true, botCreationPending: false });
  });

  it("opens one modal with exclusive keyboard ownership", () => {
    const start = { ...initialState, settingsOpen: true, appSettingsOpen: true, pluginsOpen: true, shortcutsOpen: true, computerOpen: true };
    const next = reducer(start, { type: "toggleNewBot", open: true });
    expect(next).toMatchObject({ newBotOpen: true, settingsOpen: false, appSettingsOpen: false, pluginsOpen: false, shortcutsOpen: false, computerOpen: true });
    expect(reducer(next, { type: "toggleNewBot", open: false })).toMatchObject({ settingsOpen: false, pluginsOpen: false });
  });

  it("lands the dog editor on Details for a bare open and on the named section for a deep link", () => {
    const bare = reducer(initialState, { type: "toggleSettings", open: true });
    expect(bare.botSettingsExpandAccordion).toBe(false);
    const linked = reducer(initialState, { type: "toggleSettings", open: true, section: "skills" });
    expect(linked).toMatchObject({ settingsOpen: true, botSettingsSection: "skills", botSettingsExpandAccordion: true });
    expect(reducer(linked, { type: "toggleSettings", open: false })).toMatchObject({ settingsOpen: false, botSettingsExpandAccordion: false });
  });

  it("opens the requested Plugins surface and remembers it on reopen", () => {
    const next = reducer({ ...initialState, settingsOpen: true }, { type: "togglePlugins", open: true, surface: "mcp" });
    expect(next).toMatchObject({ pluginsOpen: true, pluginsSurface: "mcp", settingsOpen: false });
    const closed = reducer(next, { type: "togglePlugins", open: false });
    expect(reducer(closed, { type: "togglePlugins", open: true })).toMatchObject({ pluginsSurface: "mcp" });
  });
});
