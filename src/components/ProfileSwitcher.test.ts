// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AddProfileDialog,
  EditProfilesDialog,
  profileBadge,
  profileEntryItem,
  profileError,
  profileName,
  profilePageItems,
  useProfiles,
  type ProfileBridge,
} from "./ProfileSwitcher";

const BUSINESS = "p00000000000a";
const SECOND = "p00000000000b";
const STARTING = "p00000000000c";
const NEW = "p00000000000d";

const profilesOf = (activeId = "main", extra: Partial<DesktopProfileList> = {}): DesktopProfileList => ({
  activeId,
  canAdd: true,
  profiles: [
    { id: "main", name: "", main: true, status: "running" },
    { id: BUSINESS, name: "Business", main: false, status: "running" },
  ],
  ...extra,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeBridge(overrides: Partial<ProfileBridge> = {}): ProfileBridge {
  return {
    list: vi.fn(async () => profilesOf()),
    add: vi.fn(async () => ({ ...profilesOf(), added: { id: NEW, ready: true } })),
    switch: vi.fn(async () => profilesOf()),
    rename: vi.fn(async () => profilesOf()),
    remove: vi.fn(async () => profilesOf()),
    onChanged: vi.fn(() => () => {}),
    ...overrides,
  };
}

const ipcError = (message: string) => new Error(`Error invoking remote method 'profiles:switch': Error: ${message}`);

describe("profile words", () => {
  it("shows the runner's own message without Electron's wrapper", () => {
    expect(profileError(ipcError("Business could not start"))).toBe("Business could not start");
    expect(profileError(new Error(`Error invoking remote method "profiles:add": You can have up to 8 profiles`))).toBe(
      "You can have up to 8 profiles",
    );
    expect(profileError("That profile no longer exists")).toBe("That profile no longer exists");
    expect(profileError(new Error("Error invoking remote method 'profiles:add': Error: "))).toBe("Something went wrong. Try again.");
    expect(profileError({ message: "not an error" })).toBe("Something went wrong. Try again.");
  });

  it("calls the unnamed first profile Personal", () => {
    expect(profileName({ name: "" })).toBe("Personal");
    expect(profileName({ name: "  " })).toBe("Personal");
    expect(profileName({ name: " Business " })).toBe("Business");
  });

  it("badges a profile with up to two letters", () => {
    expect(profileBadge("Business 2")).toBe("B2");
    expect(profileBadge("personal")).toBe("P");
    expect(profileBadge("my side gig")).toBe("MS");
    expect(profileBadge("🐶 Dogs")).toBe("🐶D");
    expect(profileBadge("   ")).toBe("?");
  });
});

describe("the Switch profile page", () => {
  const handlers = () => ({ onBack: vi.fn(), onSwitch: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn() });
  const list = profilesOf("main", {
    profiles: [
      { id: "main", name: "", main: true, status: "running" },
      { id: BUSINESS, name: "Business", main: false, status: "running" },
      { id: SECOND, name: "Business 2", main: false, status: "failed" },
      { id: STARTING, name: "Side", main: false, status: "starting" },
    ],
  });
  const markup = (node: React.ReactNode) => renderToStaticMarkup(createElement("div", null, node));

  it("opens from one row that keeps the menu open", () => {
    const onOpen = vi.fn();
    const item = profileEntryItem(onOpen);
    expect(item).toMatchObject({ key: "profiles", label: "Switch profile", keepOpen: true });
    item.onSelect();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("lists Back, every profile, then Add and Edit", () => {
    const on = handlers();
    const items = profilePageItems({ list, switching: null, error: null, ...on });
    expect(items.map((item) => item.key)).toEqual([
      "profiles-back",
      "profile-main",
      `profile-${BUSINESS}`,
      `profile-${SECOND}`,
      `profile-${STARTING}`,
      "profiles-add",
      "profiles-edit",
    ]);
    expect(items.map((item) => item.label)).toEqual(["Back", "Personal", "Business", "Business 2", "Side", "Add profile", "Edit profiles"]);
    expect(items.filter((item) => item.separatorBefore).map((item) => item.key)).toEqual(["profile-main", "profiles-add"]);
    expect(items[0]!.keepOpen).toBe(true);
    items[0]!.onSelect();
    expect(on.onBack).toHaveBeenCalledOnce();
    items.at(-2)!.onSelect();
    items.at(-1)!.onSelect();
    expect(on.onAdd).toHaveBeenCalledOnce();
    expect(on.onEdit).toHaveBeenCalledOnce();
  });

  it("ticks the open profile and switches to any other", () => {
    const on = handlers();
    const items = profilePageItems({ list, switching: null, error: null, ...on });
    const [open, business, failed, starting] = items.slice(1, 5);
    expect(open!.keepOpen).toBe(false);
    expect(markup(open!.trailing)).toContain('aria-label="In use"');
    open!.onSelect();
    expect(on.onSwitch).not.toHaveBeenCalled();
    expect(business!.keepOpen).toBe(true);
    expect(business!.trailing).toBeUndefined();
    business!.onSelect();
    expect(on.onSwitch).toHaveBeenCalledWith(BUSINESS);
    expect(failed!.note).toBe("Didn't start. Choose it to try again.");
    expect(markup(starting!.trailing)).toContain("animate-spin");
    expect(starting!.note).toBeUndefined();
    expect(markup(open!.icon)).toContain(">P<");
    expect(markup(failed!.icon)).toContain(">B2<");
  });

  it("spins on the profile being opened and holds Add and Edit until it is done", () => {
    const items = profilePageItems({ list, switching: SECOND, error: null, ...handlers() });
    const row = items.find((item) => item.key === `profile-${SECOND}`)!;
    expect(row.disabled).toBe(true);
    expect(row.note).toBeUndefined();
    expect(markup(row.trailing)).toContain("animate-spin");
    expect(items.find((item) => item.key === `profile-${BUSINESS}`)!.disabled).toBe(false);
    expect(items.at(-2)!.disabled).toBe(true);
    expect(items.at(-1)!.disabled).toBe(true);
  });

  it("puts a failed switch's own reason on that row", () => {
    const items = profilePageItems({ list, switching: null, error: { id: SECOND, message: "Business 2 could not start" }, ...handlers() });
    expect(items.find((item) => item.key === `profile-${SECOND}`)!.note).toBe("Business 2 could not start");
    expect(items.find((item) => item.key === `profile-${BUSINESS}`)!.note).toBeUndefined();
  });

  it("says why no more profiles can be added", () => {
    const items = profilePageItems({ list: { ...list, canAdd: false }, switching: null, error: null, ...handlers() });
    expect(items.at(-2)).toMatchObject({ disabled: true, note: "That's the most profiles you can have." });
    expect(items.at(-1)!.disabled).toBe(false);
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mount(element: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
}

const press = async (key: string, target: Element | null = document.activeElement) => {
  await act(async () => {
    (target ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
};
const type = async (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
  );
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe("useProfiles", () => {
  function Probe() {
    const profiles = useProfiles();
    return createElement("output", null, profiles ? `${profiles.list.activeId}:${profiles.list.profiles.length}` : "none");
  }
  const shown = () => host?.querySelector("output")?.textContent;

  it("has nothing to offer without the desktop bridge", async () => {
    vi.stubGlobal("laterdog", undefined);
    await mount(createElement(Probe));
    expect(shown()).toBe("none");
  });

  it("follows the desktop app's changes and lets go when it unmounts", async () => {
    let changed: ((state: DesktopProfileList) => void) | null = null;
    const stop = vi.fn();
    const bridge = fakeBridge({
      onChanged: vi.fn((callback) => {
        changed = callback;
        return stop;
      }),
    });
    vi.stubGlobal("laterdog", { profiles: bridge });
    await mount(createElement(Probe));
    expect(shown()).toBe("main:2");
    await act(async () => changed!(profilesOf(BUSINESS)));
    expect(shown()).toBe(`${BUSINESS}:2`);
    await act(async () => root!.unmount());
    root = null;
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps a change that arrives before the first list", async () => {
    const first = deferred<DesktopProfileList>();
    let changed: ((state: DesktopProfileList) => void) | null = null;
    const bridge = fakeBridge({
      list: vi.fn(() => first.promise),
      onChanged: vi.fn((callback) => {
        changed = callback;
        return () => {};
      }),
    });
    vi.stubGlobal("laterdog", { profiles: bridge });
    await mount(createElement(Probe));
    await act(async () => changed!(profilesOf(BUSINESS)));
    await act(async () => first.resolve(profilesOf("main")));
    expect(shown()).toBe(`${BUSINESS}:2`);
  });
});

describe("Add a profile", () => {
  const nameField = () => dialog()!.querySelector<HTMLInputElement>("input")!;

  it("opens over everything, ready for a name", async () => {
    await mount(createElement(AddProfileDialog, { bridge: fakeBridge(), onClose: vi.fn() }));
    const overlay = document.body.querySelector(":scope > div.fixed.inset-0");
    expect(overlay?.contains(dialog())).toBe(true);
    expect(host!.contains(dialog())).toBe(false);
    expect(dialog()!.getAttribute("aria-labelledby")).toBe(dialog()!.querySelector("h2")!.id);
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Add a profile");
    expect(document.activeElement).toBe(nameField());
    expect(nameField().maxLength).toBe(40);
    expect(button("Add")!.disabled).toBe(true);
  });

  it("adds the profile, then opens it", async () => {
    const opened = deferred<DesktopProfileList>();
    const bridge = fakeBridge({ switch: vi.fn(() => opened.promise) });
    const onClose = vi.fn();
    await mount(createElement(AddProfileDialog, { bridge, onClose }));
    await type(nameField(), "  Business 2 ");
    await click(button("Add"));
    expect(bridge.add).toHaveBeenCalledWith("Business 2");
    expect(bridge.switch).toHaveBeenCalledWith(NEW);
    expect(button("Setting up…")!.disabled).toBe(true);
    expect(dialog()!.getAttribute("aria-busy")).toBe("true");
    await press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => opened.resolve(profilesOf(NEW)));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not add a second copy when the new profile will not start", async () => {
    const bridge = fakeBridge({
      add: vi.fn(async () => ({
        ...profilesOf("main", { profiles: [...profilesOf().profiles, { id: NEW, name: "Side Gig", main: false, status: "failed" }] }),
        added: { id: NEW, ready: false },
      })),
    });
    const onClose = vi.fn();
    await mount(createElement(AddProfileDialog, { bridge, onClose }));
    await type(nameField(), "Side   Gig");
    await click(button("Add"));
    expect(bridge.switch).not.toHaveBeenCalled();
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe(
      "Side Gig was added but didn't start. Choose it under Switch profile to try again.",
    );
    expect(button("Add")).toBeUndefined();
    expect(onClose).not.toHaveBeenCalled();
    await click([...document.querySelectorAll("button")].find((element) => element.textContent === "Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("lets the person try again when adding fails, and stops after a profile exists", async () => {
    const add = vi
      .fn<ProfileBridge["add"]>()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'profiles:add': Error: You can have up to 8 profiles"))
      .mockResolvedValueOnce({ ...profilesOf(), added: { id: NEW, ready: true } });
    const bridge = fakeBridge({ add, switch: vi.fn(async () => Promise.reject(ipcError("Business could not start"))) });
    await mount(createElement(AddProfileDialog, { bridge, onClose: vi.fn() }));
    await type(nameField(), "Business");
    await click(button("Add"));
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe("You can have up to 8 profiles");
    expect(button("Add")!.disabled).toBe(false);
    await click(button("Add"));
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe("Business could not start");
    expect(button("Add")).toBeUndefined();
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("closes from Escape, the backdrop or Cancel when nothing is in flight", async () => {
    for (const close of [
      () => press("Escape"),
      () =>
        act(async () => {
          document.body.querySelector(":scope > div.fixed.inset-0")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        }),
      () => click(button("Cancel")),
    ]) {
      const onClose = vi.fn();
      await mount(createElement(AddProfileDialog, { bridge: fakeBridge(), onClose }));
      await close();
      expect(onClose).toHaveBeenCalledOnce();
      await act(async () => root!.unmount());
      root = null;
      document.body.innerHTML = "";
    }
  });
});

describe("Edit profiles", () => {
  const list = profilesOf(BUSINESS, {
    profiles: [
      { id: "main", name: "", main: true, status: "running" },
      { id: BUSINESS, name: "Business", main: false, status: "running" },
      { id: SECOND, name: "Business 2", main: false, status: "running" },
    ],
  });
  const field = (label: string) => dialog()!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const blur = async (input: HTMLInputElement) => {
    await act(async () => {
      input.focus();
    });
    await act(async () => {
      input.blur();
    });
  };

  it("names every profile and offers removal only where it is allowed", async () => {
    await mount(createElement(EditProfilesDialog, { bridge: fakeBridge(), list, onClose: vi.fn() }));
    expect(field("Rename Personal").value).toBe("");
    expect(field("Rename Personal").placeholder).toBe("Personal");
    expect(field("Rename Business").value).toBe("Business");
    expect(button("Remove Personal")).toBeUndefined();
    expect(button("Remove Business")).toBeUndefined();
    expect(dialog()!.textContent).toContain("In use");
    expect(button("Remove Business 2")).toBeTruthy();
    expect(document.activeElement).toBe(dialog());
  });

  it("renames when a field is left, tidying the spaces", async () => {
    const bridge = fakeBridge();
    await mount(createElement(EditProfilesDialog, { bridge, list, onClose: vi.fn() }));
    await type(field("Rename Business 2"), "  Business   Two ");
    await blur(field("Rename Business 2"));
    expect(bridge.rename).toHaveBeenCalledWith(SECOND, "Business Two");
    expect(field("Rename Business 2").value).toBe("Business Two");
    await blur(field("Rename Business"));
    expect(bridge.rename).toHaveBeenCalledOnce();
  });

  it("Enter finishes a rename", async () => {
    const bridge = fakeBridge();
    await mount(createElement(EditProfilesDialog, { bridge, list, onClose: vi.fn() }));
    await act(async () => {
      field("Rename Business").focus();
    });
    await type(field("Rename Business"), "Work");
    await press("Enter", field("Rename Business"));
    expect(bridge.rename).toHaveBeenCalledWith(BUSINESS, "Work");
  });

  it("puts a blank name back, except Personal's, which goes back to Personal", async () => {
    const bridge = fakeBridge();
    const named = { ...list, profiles: list.profiles.map((profile) => (profile.main ? { ...profile, name: "Home" } : profile)) };
    await mount(createElement(EditProfilesDialog, { bridge, list: named, onClose: vi.fn() }));
    await type(field("Rename Business 2"), "   ");
    await blur(field("Rename Business 2"));
    expect(field("Rename Business 2").value).toBe("Business 2");
    expect(bridge.rename).not.toHaveBeenCalled();
    await type(field("Rename Home"), "  ");
    await blur(field("Rename Home"));
    expect(bridge.rename).toHaveBeenCalledWith("main", "");
    expect(field("Rename Home").value).toBe("");
    expect(field("Rename Home").placeholder).toBe("Personal");
  });

  it("asks before removing, and Escape there only closes the question", async () => {
    const removed = deferred<DesktopProfileList>();
    const bridge = fakeBridge({ remove: vi.fn(() => removed.promise) });
    const onClose = vi.fn();
    await mount(createElement(EditProfilesDialog, { bridge, list, onClose }));
    await click(button("Remove Business 2"));
    const question = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(question()!.textContent).toContain("Remove Business 2?");
    expect(question()!.textContent).toContain("Its dogs and chats move to the Trash");
    await press("Escape");
    expect(question()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge.remove).not.toHaveBeenCalled();

    await click(button("Remove Business 2"));
    await click([...question()!.querySelectorAll("button")].find((element) => element.textContent === "Remove"));
    expect(bridge.remove).toHaveBeenCalledWith(SECOND);
    expect(button("Done")!.disabled).toBe(true);
    await act(async () => removed.resolve(profilesOf(BUSINESS)));
    expect(question()).toBeNull();
    expect(button("Done")!.disabled).toBe(false);
  });

  it("shows why a removal failed", async () => {
    const bridge = fakeBridge({
      remove: vi.fn(async () => Promise.reject(ipcError("This profile is still shutting down. Try again in a moment."))),
    });
    await mount(createElement(EditProfilesDialog, { bridge, list, onClose: vi.fn() }));
    await click(button("Remove Business 2"));
    await click([...document.querySelectorAll('[role="alertdialog"] button')].find((element) => element.textContent === "Remove"));
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe("This profile is still shutting down. Try again in a moment.");
  });
});
