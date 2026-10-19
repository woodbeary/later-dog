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
  const sent = (request: { mock: { calls: unknown[][] } }) => {
    expect(request.mock.calls).toHaveLength(1);
    const [path, init] = request.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/api/bots");
    expect(init.method).toBe("POST");
    return JSON.parse(init.body) as Record<string, unknown>;
  };
  const once = { createId: expect.stringMatching(/^[A-Za-z0-9_-]{16,80}$/), hello: true };

  it("keeps the generated picture in the creation request", async () => {
    const request = vi.fn(async () => ({ bot: { id: "generated-dog" } })) as unknown as Parameters<typeof createDog>[1];
    await createDog({ name: "Scout", avatarUrl: "/api/attachments/generated.png", avatarCrop: "circle", offLeash: true }, request);
    expect(sent(request as never)).toEqual({ ...once, name: "Scout", settings: { approvalMode: "auto", avatarUrl: "/api/attachments/generated.png", avatarCrop: "circle" } });
  });

  it("creates a dog with one request that carries its own create id and asks the server to say hello", async () => {
    const request = vi.fn().mockResolvedValue({ bot });
    expect(await createDog({}, request)).toEqual({ bot });
    expect(sent(request)).toEqual(once);
  });

  it("sends the create id it was given, so a retry of the same sheet makes one dog", async () => {
    const request = vi.fn().mockResolvedValue({ bot });
    await createDog({ createId: "sheet-0123456789abcdef" }, request);
    await createDog({ createId: "sheet-0123456789abcdef" }, request);
    expect(request.mock.calls.map(([, init]) => JSON.parse(init.body).createId)).toEqual(["sheet-0123456789abcdef", "sheet-0123456789abcdef"]);
  });

  it("mints a different create id for each call without one", async () => {
    const first = vi.fn().mockResolvedValue({ bot });
    const second = vi.fn().mockResolvedValue({ bot });
    await createDog({}, first);
    await createDog({}, second);
    expect(sent(first).createId).not.toBe(sent(second).createId);
  });

  it("sends the name and purpose trimmed, and the host model with requireAvailableModel", async () => {
    const request = vi.fn().mockResolvedValue({ bot });
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    await createDog({ name: " Scout ", title: " Trips ", modelSelection }, request);
    expect(sent(request)).toEqual({ ...once, name: "Scout", title: "Trips", modelSelection, requireAvailableModel: true });
  });

  it("leaves blank fields to the server's own defaults", async () => {
    const request = vi.fn().mockResolvedValue({ bot });
    await createDog({ name: "  ", title: "" }, request);
    expect(sent(request)).toEqual(once);
  });

  it("asks for Off-leash in the same POST when the dialog starts the dog off-leash", async () => {
    const request = vi.fn().mockResolvedValue({ bot });
    await createDog({ name: "Scout", offLeash: true }, request);
    expect(sent(request)).toEqual({ ...once, name: "Scout", settings: { approvalMode: "auto" } });
  });

  it("creates directly in the selected team in the one POST", async () => {
    const request = vi.fn().mockResolvedValue({ bot: { ...bot, section: "Studio" } });
    const created = await createDog({ section: "Studio" }, request);
    expect(sent(request)).toEqual({ ...once, section: "Studio" });
    expect(created.bot.section).toBe("Studio");
  });

  it("creates a restricted dog already restricted; everyone is the default and is not sent", async () => {
    const request = vi.fn().mockResolvedValue({ bot });
    await createDog({ visibility: "admins" }, request);
    expect(sent(request)).toEqual({ ...once, visibility: "admins" });
    const open = vi.fn().mockResolvedValue({ bot });
    await createDog({ visibility: "everyone" }, open);
    expect(sent(open)).toEqual(once);
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

  it("blocks duplicates across dismissal until creation settles, with no second hello call", async () => {
    const post = deferred();
    const request = vi.fn<typeof fetch>().mockReturnValueOnce(post.promise).mockResolvedValue(response({ bot }));
    const dispatch = mount(request);
    const onCreated = vi.fn();
    const onError = vi.fn();
    dispatch({ type: "newBot", createId: "sheet-0123456789abcdef", name: "Scout", title: "Trips", onCreated, onError });
    dispatch({ type: "toggleNewBot", open: false });
    dispatch({ type: "toggleNewBot", open: true });
    dispatch({ type: "newBot" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toEqual({ createId: "sheet-0123456789abcdef", hello: true, name: "Scout", title: "Trips" });
    post.resolve(response({ bot }));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(bot);
    expect(onError).not.toHaveBeenCalled();
    dispatch({ type: "newBot" });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/bots", "/api/bots"]);
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
    const state = { ...initialState, selectedId: "existing" };
    const next = reducer(state, { type: "botAdded", bot, preserveSelection });
    expect(next.bots).toContain(bot);
    expect(next.selectedId).toBe(preserveSelection ? "existing" : "created");
    expect(reducer(state, { type: "botAdded", bot })).toMatchObject({ selectedId: "created" });
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
