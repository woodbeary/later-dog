import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, Message } from "@/state/store";
import type { ManagedSkill } from "./bot-settings/SkillsSection";

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

const { BotSettingsDialog, looksLikeSkillSource } = await import("./BotSettingsDialog");
const { botLibraryItems } = await import("./bot-settings/library");
const { BOT_SECTIONS, tabForSection } = await import("./bot-settings/sections");
const { SoulField } = await import("./SoulField");
const { ModelPicker } = await import("./ModelPicker");
const { SimpleMemory } = await import("./bot-settings/SimpleMemory");
const { RoutinesCard } = await import("./bot-settings/RoutinesCard");
const { ComputerTab } = await import("./bot-settings/ComputerTab");
const { ProfileAvatar } = await import("./bot-settings/ProfileAvatar");

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
    patch, activeState: "idle",
  };
});

describe("the dog editor's tabs", () => {
  it("has Details, Library and Computer, and lands on Details when opened bare", () => {
    expect(BOT_SECTIONS.map((entry) => entry.id)).toEqual(["details", "library", "computer"]);
    const { html, nodes: tree } = dialog(makeBot());
    expect(html).toContain(">Details</button>");
    expect(html).toContain(">Library</button>");
    expect(html).toContain(">Computer</button>");
    expect(html).not.toContain("Where Scout works");
    expect(tree.some((node) => node.type === ComputerTab)).toBe(false);
    expect(find({ nodes: tree }, "data-simple-tab", "details").props["aria-selected"]).toBe(true);
    for (const gone of ["All settings", "Search settings", "SOUL.md", "Advanced", "Slack", "Who can see it", "History", "Usage"]) {
      expect(html).not.toContain(gone);
    }
  });

  it("names a section through the store when a tab is pressed, so deep links and taps share one path", () => {
    const rendered = dialog(makeBot());
    click(find(rendered, "data-simple-tab", "library"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true, section: "skills" });
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

  it("shows the dog's own screen on Computer, and only there", () => {
    const bot = makeBot();
    openTab("access");
    const rendered = dialog(bot);
    expect(find(rendered, "data-simple-tab", "computer").props["aria-selected"]).toBe(true);
    const screen = rendered.nodes.find((node) => node.type === ComputerTab)!;
    expect(screen.props.bot).toBe(bot);
    expect(rendered.html).not.toContain(">Look</span>");
    expect(rendered.html).toContain("Scout&#x27;s screen");
    click(find(rendered, "data-simple-tab", "computer"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true, section: "access" });
  });

  it("puts the picture, name and label at the top, above the tabs, with the dialog still named by the dog", () => {
    const bot = makeBot();
    const rendered = dialog(bot);
    const avatar = rendered.nodes.find((node) => node.type === ProfileAvatar)!;
    expect(avatar.props.bot).toBe(bot);
    expect(avatar.props.onPatch).toBe(patch);
    expect(avatar.props.state).toBe("idle");
    expect(rendered.html).toMatch(/<span id="bot-settings-title" class="sr-only">Scout<\/span>/);
    expect(find(rendered, "id", "simple-bot-label-scout").props.placeholder).toBe("Add a label");
    const at = (text: string) => rendered.html.indexOf(text);
    expect(at("data-avatar-edit")).toBeLessThan(at("data-profile-name"));
    expect(at("data-profile-name")).toBeLessThan(at("data-profile-label"));
    expect(at("data-profile-label")).toBeLessThan(at('role="tablist"'));
    expect(at('role="tablist"')).toBeLessThan(at(">Look</span>"));
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
  it("shows the look, the plain fields and what it runs on, with no per-dog approval control", () => {
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
    for (const gone of ["Shape", "Expression", "Upload", "Generate with AI", "Image provider", "Job", "Before Scout acts", "Heel", "Off-leash", "data-approval-choice"]) {
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
  });
});

describe("Routines", () => {
  it("hands the routines card the dog, under the Routines label", () => {
    fixture.storeState = { ...fixture.storeState, routinesLoadState: "ready" };
    const bot = makeBot();
    const rendered = dialog(bot);
    expect(rendered.html).toContain(">Routines</span>");
    expect(rendered.html).toContain("Ask Scout to do something every morning, or every Friday, and it shows up here.");
    const card = rendered.nodes.find((node) => node.type === RoutinesCard)!;
    expect(card.props.bot).toBe(bot);
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
    expect(find(dialog(bot), "data-simple-add-skill").props.children).toBe("Done");
  });

  it("closes the teach row from its own button or with Escape, leaving the dialog open", () => {
    const bot = makeBot();
    const shut = (rendered: { nodes: Node[] }) => !rendered.nodes.some((node) => node.props["data-simple-teach"] !== undefined);
    click(find(dialog(bot), "data-simple-add-skill"));
    const open = dialog(bot);
    expect(find(open, "data-simple-add-skill").props.children).toBe("Cancel");
    change(find(open, "aria-label", "Teach a trick"), "half a thought");
    click(find(dialog(bot), "data-simple-add-skill"));
    const closed = dialog(bot);
    expect(shut(closed)).toBe(true);
    expect(find(closed, "data-simple-add-skill").props).toMatchObject({ "aria-expanded": false, children: "Teach a trick" });

    click(find(closed, "data-simple-add-skill"));
    const reopened = dialog(bot);
    expect(find(reopened, "aria-label", "Teach a trick").props.value).toBe("");
    const typing = { key: "a", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (find(reopened, "data-simple-teach").props.onKeyDown as (event: unknown) => void)(typing);
    expect(shut(dialog(bot))).toBe(false);
    const escape = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (find(dialog(bot), "data-simple-teach").props.onKeyDown as (event: unknown) => void)(escape);
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(shut(dialog(bot))).toBe(true);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("teaches a trick from plain words by asking the dog, in its chat", async () => {
    const bot = makeBot();
    click(find(dialog(bot), "data-simple-add-skill"));
    expect(dialog(bot).html).toContain('placeholder="What should Scout learn?"');
    change(find(dialog(bot), "aria-label", "Teach a trick"), "Turn my notes into a weekly update");
    fixture.request = vi.fn(() => Promise.resolve({}));
    const form = find(dialog(bot), "data-simple-teach");
    await (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => {} });
    expect(fixture.request).not.toHaveBeenCalled();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "send", botId: "scout", threadId: "thread-scout", text: "Learn a new trick: Turn my notes into a weekly update" });
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: false });
  });

  it("tells a link or owner/repo from words describing a trick", () => {
    for (const source of ["github:acme/skill", "acme/skill", "https://example.com/SKILL.md", "github.com/acme/skill"]) expect(looksLikeSkillSource(source)).toBe(true);
    for (const words of ["Turn my notes into a weekly update", "summarise PRs / issues daily"]) expect(looksLikeSkillSource(words)).toBe(false);
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
    const memory = rendered.nodes.find((node) => node.type === SimpleMemory)!;
    expect(memory.props.active).toBe(true);
    (memory.props.onToggle as (enabled: boolean) => void)(false);
    expect(patch).toHaveBeenLastCalledWith({ memoryEnabled: false });
    openTab("identity");
    const details = dialog(makeBot());
    expect(details.nodes.find((node) => node.type === SimpleMemory)!.props.active).toBe(false);
  });

  it("opens Manage memory as its own page inside Library, and Back returns to the tab", () => {
    const memory = dialog(makeBot()).nodes.find((node) => node.type === SimpleMemory)!;
    expect(memory.props.page).toBe(false);
    (memory.props.onPage as (open: boolean) => void)(true);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true, section: "memory" });
    openTab("memory");
    const page = dialog(makeBot());
    const shown = page.nodes.find((node) => node.type === SimpleMemory)!;
    expect(shown.props.page).toBe(true);
    expect(shown.props.active).toBe(true);
    expect(page.html).not.toContain(">Tricks<");
    expect(page.html).toContain('data-memory-page="home"');
    expect(page.html).not.toContain("data-simple-memory");
    (shown.props.onPage as (open: boolean) => void)(false);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: true, section: "skills" });
  });

  it("leaves Made in chat out until the dog has made something, then lists it", () => {
    expect(dialog(makeBot()).html).not.toContain("Made in chat");
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
