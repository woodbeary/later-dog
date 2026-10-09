import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, Message } from "@/state/store";
import type { ManagedSkill } from "./bot-settings/SkillsSection";

// Same hook-by-call-order harness as ModelPicker.simple.test.ts: component
// state survives between renders, effects never run, and handlers are read
// off the returned element tree.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    values: [] as unknown[],
    index: 0,
    own: 0,
    dispatch: (() => {}) as (...args: unknown[]) => void,
    request: (() => Promise.resolve({})) as (...args: unknown[]) => Promise<unknown>,
    storeState: {} as Record<string, unknown>,
    skills: {
      skills: [] as ManagedSkill[],
      loading: false,
      working: "",
      error: "",
      reviewing: null as null | { skill: ManagedSkill; text: string },
      libraryPool: [] as { name: string }[],
      addFromLibrary: "",
      toggle: (() => Promise.resolve()) as (skill: ManagedSkill) => Promise<void>,
      refresh: (() => Promise.resolve()) as () => Promise<void>,
      addToBot: (() => Promise.resolve()) as () => Promise<void>,
    },
    derived: {} as Record<string, unknown>,
  };
});
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
}));
// place-view's seat reads the interface mode; the dialog itself no longer does.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./bot-settings/useBotSettingsDerived", () => ({ useBotSettingsDerived: () => fixture.derived }));
vi.mock("./bot-settings/BotEditorContext", () => ({ useBotEditor: () => ({ request: fixture.request }) }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./DesktopCapabilities")>()),
  useCaptionChrome: () => ({ padClass: "" }),
}));
vi.mock("./Avatar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Avatar")>()),
  BotAvatar: () => null,
  DogAvatar: () => null,
}));
vi.mock("./bot-settings/SkillsSection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-settings/SkillsSection")>()),
  useManagedSkills: () => ({
    ...fixture.skills, setReviewing: () => {}, setError: () => {}, setAddFromLibrary: () => {}, enableReviewed: () => Promise.resolve(),
  }),
}));
vi.mock("@/state/store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@/state/store")>();
  return {
    ...store,
    useStore: () => ({
      state: { ...store.initialState, ...fixture.storeState },
      dispatch: fixture.dispatch,
      flushBotPatches: () => Promise.resolve(),
    }),
  };
});

const { BotSettingsDialog } = await import("./BotSettingsDialog");
const { botLibraryItems } = await import("./bot-settings/library");
const { BOT_SECTIONS, tabForSection } = await import("./bot-settings/sections");
const { SoulField } = await import("./SoulField");
const { LocalComputerAutoWarning } = await import("./LocalComputerAutoWarning");
const { ModelPicker } = await import("./ModelPicker");
const { MemorySection } = await import("./bot-settings/MemorySection");

afterAll(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}

function makeBot(extra: Partial<Bot> = {}): Bot {
  return {
    id: "scout", threadId: "thread-scout", name: "Scout", title: "Researcher", description: "", soul: "Be brief.",
    notifications: true, color: "green", unread: false, messages: [],
    modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    ...extra,
  };
}

function capture(component: () => ReactNode) {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = component();
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

const patch = vi.fn();
const dialog = (bot: Bot) => capture(() => BotSettingsDialog({ bot }));
const find = (rendered: { nodes: Node[] }, attr: string, value: unknown = true) =>
  rendered.nodes.find((node) => node.props[attr] === value)!;
const click = (node: Node) => (node.props.onClick as () => void)();
const change = (node: Node, value: string) => (node.props.onChange as (e: unknown) => void)({ target: { value } });
const openTab = (section: string) => {
  fixture.storeState = { settingsOpen: true, botSettingsSection: section, botSettingsExpandAccordion: true };
};

const skill = (name: string, enabled: boolean): ManagedSkill => ({ name, description: `${name} helper`, enabled, source: "github:x/y", warnings: [] });

beforeEach(() => {
  fixture.values = [];
  fixture.index = 0;
  fixture.own = 0;
  fixture.dispatch = vi.fn();
  fixture.request = vi.fn(() => Promise.resolve({}));
  fixture.storeState = { settingsOpen: true, botSettingsSection: "overview", botSettingsExpandAccordion: false };
  fixture.skills = {
    skills: [], loading: false, working: "", error: "", reviewing: null, libraryPool: [], addFromLibrary: "",
    toggle: vi.fn(() => Promise.resolve()), refresh: vi.fn(() => Promise.resolve()), addToBot: vi.fn(() => Promise.resolve()),
  };
  patch.mockReset();
  fixture.derived = {
    patch, approvalMode: "ask", engine: { driverKind: "claudeAgent" }, trustedModesAvailable: false, activeState: "idle",
    botRoutines: [],
  };
});

describe("the dog editor's tabs", () => {
  it("has exactly Details, Library and Computer, and lands on Details when opened bare", () => {
    expect(BOT_SECTIONS.map((entry) => entry.id)).toEqual(["details", "library", "computer"]);
    const { html, nodes: tree } = dialog(makeBot());
    expect(html).toContain(">Details</button>");
    expect(html).toContain(">Library</button>");
    expect(html).toContain(">Computer</button>");
    expect(find({ nodes: tree }, "data-simple-tab", "details").props["aria-selected"]).toBe(true);
    for (const gone of ["All settings", "Search settings", "SOUL.md", "Advanced", "Slack", "Who can see it", "History", "Usage"]) {
      expect(html).not.toContain(gone);
    }
  });

  it("names a section through the store when a tab is pressed, so deep links and taps share one path", () => {
    const rendered = dialog(makeBot());
    click(find(rendered, "data-simple-tab", "library"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true, section: "skills" });
    click(find(rendered, "data-simple-tab", "computer"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true, section: "access" });
  });

  it("folds the old section ids onto the three tabs", () => {
    expect(tabForSection("skills")).toBe("library");
    expect(tabForSection("memory")).toBe("library");
    expect(tabForSection("access")).toBe("computer");
    for (const section of ["overview", "identity", "soul", "model", "permissions", "voice", "history", "usage"] as const) {
      expect(tabForSection(section)).toBe("details");
    }
    openTab("memory");
    expect(find(dialog(makeBot()), "data-simple-tab", "library").props["aria-selected"]).toBe(true);
    openTab("model");
    expect(find(dialog(makeBot()), "data-simple-tab", "details").props["aria-selected"]).toBe(true);
  });

  it("closes from the header button and names it for screen readers", () => {
    const rendered = dialog(makeBot());
    const close = find(rendered, "aria-label", "Close settings");
    expect(close.props.title).toBe("Close settings");
    click(close);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: false });
  });
});

describe("Details", () => {
  it("shows the look, the plain fields, what it runs on and the ask/decide control", () => {
    const { html } = dialog(makeBot());
    expect(html).toContain(">Look</span>");
    expect(html).toContain('aria-label="Breed"');
    expect(html).toContain('aria-label="Color"');
    expect(html).toContain(">Name</label>");
    expect(html).toContain(">Add a label</label>");
    expect(html).toContain("value=\"Scout\"");
    expect(html).toContain("value=\"Researcher\"");
    expect(html).toContain(">Instructions</label>");
    expect(html).toContain("Be brief.");
    expect(html).toContain(">Runs on</span>");
    expect(html).toContain("Before Scout acts");
    expect(html).toContain("Heel");
    expect(html).toContain("Off-leash");
    for (const gone of ["Shape", "Expression", "Upload", "Generate with AI", "Image provider", "Job"]) {
      expect(html).not.toContain(gone);
    }
  });

  it("picks the breed and colour as mascotBody and color, one radio per choice", () => {
    const rendered = dialog(makeBot({ mascotBody: "beagle" }));
    const breeds = rendered.nodes.filter((node) => node.props["data-breed"] !== undefined);
    expect(breeds.length).toBeGreaterThan(3);
    expect(breeds.every((node) => node.props.role === "radio")).toBe(true);
    expect(find(rendered, "data-breed", "beagle").props["aria-checked"]).toBe(true);
    const other = breeds.find((node) => node.props["data-breed"] !== "beagle")!;
    click(other);
    expect(patch).toHaveBeenLastCalledWith({ mascotBody: other.props["data-breed"] });

    expect(find(rendered, "data-color", "green").props["aria-checked"]).toBe(true);
    expect(find(rendered, "data-color", "blue").props["aria-label"]).toBe("Color: blue");
    click(find(rendered, "data-color", "blue"));
    expect(patch).toHaveBeenLastCalledWith({ color: "blue" });
  });

  it("saves name, label and instructions through the same bot patch", () => {
    const rendered = dialog(makeBot());
    change(find(rendered, "id", "simple-bot-name-scout"), "Nova");
    expect(patch).toHaveBeenLastCalledWith({ name: "Nova" });
    change(find(rendered, "id", "simple-bot-label-scout"), "Writer");
    expect(patch).toHaveBeenLastCalledWith({ title: "Writer" });
    const soul = rendered.nodes.find((node) => node.type === SoulField)!;
    expect(soul.props.onPatch).toBe(patch);
  });

  it("sets what the dog runs on in the contained picker, on the dog itself", () => {
    const bot = makeBot();
    const rendered = dialog(bot);
    const picker = rendered.nodes.find((node) => node.type === ModelPicker)!;
    expect(picker.props.contained).toBe(true);
    expect(picker.props.bot).toBe(bot);
    expect(picker.props.threadId).toBeUndefined();
    const at = (text: string) => rendered.html.indexOf(text);
    expect(at(">Instructions</label>")).toBeLessThan(at("data-simple-default-model"));
    expect(at("data-simple-default-model")).toBeLessThan(at("Before Scout acts"));
  });

  it("maps the two choices onto Ask and Decide for the dog", () => {
    const rendered = dialog(makeBot());
    expect(find(rendered, "data-approval-choice", "ask").props["aria-pressed"]).toBe(true);
    expect(find(rendered, "data-approval-choice", "auto").props["aria-pressed"]).toBe(false);
    click(find(rendered, "data-approval-choice", "auto"));
    expect(patch).toHaveBeenLastCalledWith({ approvalMode: "auto" });

    fixture.derived.approvalMode = "auto";
    click(find(dialog(makeBot()), "data-approval-choice", "ask"));
    expect(patch).toHaveBeenLastCalledWith({ approvalMode: "ask" });
  });

  it("shows legacy Antigravity Auto as Ask without changing the saved mode", () => {
    fixture.derived.engine = { driverKind: "antigravityAgent" };
    fixture.derived.approvalMode = "auto";
    const rendered = dialog(makeBot({ approvalMode: "auto" }));
    expect(find(rendered, "data-approval-choice", "ask").props["aria-pressed"]).toBe(true);
    expect(find(rendered, "data-approval-choice", "auto").props["aria-pressed"]).toBe(false);
    expect(find(rendered, "data-approval-choice", "auto").props.disabled).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("warns before Decide on this computer", () => {
    const bot = makeBot({ computer: "local" });
    click(find(dialog(bot), "data-approval-choice", "auto"));
    expect(patch).not.toHaveBeenCalled();
    const warning = dialog(bot).nodes.find((node) => node.type === LocalComputerAutoWarning)!;
    expect(warning.props.open).toBe(true);
    (warning.props.onConfirm as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({
      type: "updateBot", botId: "scout", patch: { approvalMode: "auto", acknowledgeLocalAuto: true },
    });
  });

  it("selects neither choice and says so when another level is in use", () => {
    fixture.derived.approvalMode = "full";
    const rendered = dialog(makeBot());
    expect(find(rendered, "data-approval-choice", "ask").props["aria-pressed"]).toBe(false);
    expect(find(rendered, "data-approval-choice", "auto").props["aria-pressed"]).toBe(false);
    expect(find(rendered, "data-approval-custom").props.children).toBe("A custom setting is in use. Pick one above to replace it.");
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("Library", () => {
  beforeEach(() => openTab("skills"));

  it("lists tricks with an on/off switch and a quiet line when there are none", () => {
    expect(dialog(makeBot()).html).toContain("No tricks yet.");
    const off = skill("summarise", false);
    fixture.skills.skills = [skill("triage", true), off];
    const rendered = dialog(makeBot());
    expect(rendered.html).toContain("triage");
    expect(rendered.html).toContain("summarise helper");
    click(find(rendered, "aria-label", "Use summarise"));
    expect(fixture.skills.toggle).toHaveBeenCalledWith(off);
  });

  it("disables every switch until a pending toggle settles", async () => {
    fixture.skills.skills = [skill("triage", true), skill("summarise", false)];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    fixture.skills.toggle = vi.fn(async (selected) => {
      fixture.skills.working = selected.name;
      await pending;
      fixture.skills.working = "";
    });
    click(find(dialog(makeBot()), "aria-label", "Use triage"));
    const busy = dialog(makeBot());
    expect(find(busy, "aria-label", "Use triage").props.disabled).toBe(true);
    expect(find(busy, "aria-label", "Use summarise").props.disabled).toBe(true);
    finish();
    await pending;
    const settled = dialog(makeBot());
    expect(find(settled, "aria-label", "Use triage").props.disabled).toBe(false);
  });

  it("teaches a trick from a source in place, then refreshes the list", async () => {
    const bot = makeBot();
    const closed = dialog(bot);
    expect(closed.nodes.some((node) => node.props["data-simple-teach"] !== undefined)).toBe(false);
    click(find(closed, "data-simple-add-skill"));
    const open = dialog(bot);
    expect(find(open, "data-simple-add-skill").props["aria-expanded"]).toBe(true);
    change(find(open, "aria-label", "Teach a trick"), " github:acme/skill ");
    fixture.request = vi.fn(() => Promise.resolve({ installed: [{ name: "skill" }] }));
    const form = find(dialog(bot), "data-simple-teach");
    await (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => {} });
    expect(fixture.request).toHaveBeenCalledWith("/api/bots/scout/skills", { method: "POST", body: JSON.stringify({ source: "github:acme/skill" }) });
    expect(fixture.skills.refresh).toHaveBeenCalled();
    expect(dialog(bot).html).toContain("Imported 1. Switch it on below.");
  });

  it("offers the library pool instead when the skills library is on", () => {
    fixture.storeState = { ...fixture.storeState, config: { features: { skillsLibrary: true } } };
    fixture.skills.libraryPool = [{ name: "triage" }];
    fixture.skills.addFromLibrary = "triage";
    const bot = makeBot();
    click(find(dialog(bot), "data-simple-add-skill"));
    const rendered = dialog(bot);
    expect(rendered.html).toContain("Pick a trick from the library");
    click(rendered.nodes.find((node) => node.type === "button" && node.props.children === "Add")!);
    expect(fixture.skills.addToBot).toHaveBeenCalled();
  });

  it("keeps memory mounted on every tab and lets it be switched off", () => {
    const rendered = dialog(makeBot());
    const memory = rendered.nodes.find((node) => node.type === MemorySection)!;
    expect(memory.props.active).toBe(true);
    (memory.props.onToggle as (enabled: boolean) => void)(false);
    expect(patch).toHaveBeenLastCalledWith({ memoryEnabled: false });
    openTab("identity");
    const details = dialog(makeBot());
    expect(details.nodes.find((node) => node.type === MemorySection)!.props.active).toBe(false);
  });

  it("shows the empty state, and what the dog made when there is some", () => {
    expect(dialog(makeBot()).html).toContain("Pages, files, and apps Scout makes show up here.");
    const message = {
      id: "m1", role: "bot", kind: "text", at: Date.UTC(2026, 8, 30), text: "Done",
      attachments: [{ path: "/tmp/chart.png", kind: "image" }, { path: "/tmp/report.pdf", kind: "file", name: "report.pdf" }],
    } as Message;
    const made = makeBot({ messages: [message] });
    expect(botLibraryItems(made).map((item) => item.name)).toEqual(["chart.png", "report.pdf"]);
    const rendered = dialog(made);
    expect(rendered.html).toContain("report.pdf");
    click(find(rendered, "data-library-item", "m1"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "focusMessage", threadId: "thread-scout", messageId: "m1" });
  });

  it("keeps the latest artifact reply and date while preserving each reply's file order", () => {
    const made = makeBot({ messages: [
      { id: "old", role: "bot", kind: "text", at: 100, text: "First draft", attachments: [
        { path: "/tmp/report.pdf", kind: "file", name: "draft.pdf" },
        { path: "/tmp/old-only.pdf", kind: "file", name: "old-only.pdf" },
      ] },
      { id: "latest", role: "bot", kind: "text", at: 200, text: "Updated", attachments: [
        { path: "/tmp/chart.png", kind: "image" },
        { path: "/tmp/report.pdf", kind: "file", name: "report.pdf" },
        { path: "/tmp/notes.md", kind: "file", name: "notes.md" },
      ] },
    ] as Message[] });
    expect(botLibraryItems(made).map(({ name, messageId, at }) => ({ name, messageId, at }))).toEqual([
      { name: "chart.png", messageId: "latest", at: 200 },
      { name: "report.pdf", messageId: "latest", at: 200 },
      { name: "notes.md", messageId: "latest", at: 200 },
      { name: "old-only.pdf", messageId: "old", at: 100 },
    ]);
  });
});

describe("Computer", () => {
  beforeEach(() => openTab("access"));

  it("says where the dog works in place words, Auto when nothing is chosen, and opens the panel", () => {
    const rendered = dialog(makeBot());
    const row = find(rendered, "data-testid", "access-works-on");
    expect(rendered.html).toContain("Where Scout works:");
    expect(rendered.html).not.toContain("Cloud backend");
    expect(rendered.html).not.toContain("Start VPS");
    const open = nodes(row).find((node) => node.type === "button")!;
    expect(open.props.children).toBe("Open Computer panel");
    click(open);
    expect(fixture.dispatch).toHaveBeenNthCalledWith(1, { type: "toggleSettings", open: false });
    expect(fixture.dispatch).toHaveBeenNthCalledWith(2, { type: "toggleComputer", open: true });
  });

  it("reads the chosen computer's words when one is set", () => {
    const auto = dialog(makeBot()).html.match(/Where Scout works: ([^<]*)/)![1];
    const local = dialog(makeBot({ computer: "local" })).html.match(/Where Scout works: ([^<]*)/)![1];
    expect(local).not.toBe(auto);
  });
});
