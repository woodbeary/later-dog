import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message, Task } from "@/state/store";
import type { ModelPicker } from "./ModelPicker";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { menus: [] as { ariaLabel: string; items: { key: string; disabled?: boolean; heading?: string; active?: boolean }[] }[], dispatch: vi.fn(), canWrite: null as boolean | null, showToolCalls: false, platform: "other", localReasonCode: "cua-driver-unavailable", localMessage: "", model: null as ComponentProps<typeof ModelPicker> | null,
    control: {} as Record<string, { held: boolean; helpReason: string | null }>, computerShown: false };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.showToolCalls ? { features: { showToolCalls: true } } : null,
      instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo],
      computerControl: fixture.control,
      ...(fixture.computerShown ? { settingsOpen: true, botSettingsSection: "access", botSettingsExpandAccordion: true } : {}) },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: fixture.platform }, localComputer: { available: false, reasonCode: fixture.localReasonCode, message: fixture.localMessage } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./SidebarPopoverMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("./SidebarPopoverMenu")>(),
  SidebarPopoverMenu: (props: { ariaLabel: string; items: never[]; renderTrigger: (state: { open: boolean }) => unknown }) => {
    fixture.menus.push({ ariaLabel: props.ariaLabel, items: props.items });
    return props.renderTrigger({ open: false });
  },
}));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => fixture.canWrite }));
vi.mock("./CitationUI", async (importOriginal) => ({
  ...await importOriginal<typeof import("./CitationUI")>(),
  CitationSelectionToolbar: () => createElement("span", { "data-testid": "citation-toolbar" }),
}));
vi.mock("./ModelPicker", () => ({ ModelPicker: (props: ComponentProps<typeof ModelPicker>) => {
  fixture.model = props;
  return createElement("span", { "data-test-model-control": true });
} }));
vi.mock("./ComposerPlusMenu", () => ({ ComposerPlusMenu: () => createElement("span", { "data-test-plus-menu": true }) }));

const { ChatView, ErrorRow, FailedTurnRow, claudeUpdateTarget } = await import("./ChatView");
const { activityPreview } = await import("@/lib/failed-turn");
afterAll(() => vi.unstubAllGlobals());

const bot: Bot = {
  id: "bot", threadId: "selected", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: true, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: "selected", title: "Selected", createdAt: 1, busy: false, activity: "idle",
    modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "ask" }],
};

describe("the header", () => {
  it("has a More menu with only the export, no usage, and no computer button", () => {
    fixture.menus = [];
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const more = fixture.menus.find((menu) => menu.ariaLabel === "More")!;
    expect(more.items.map((item) => item.key)).toEqual(["copy", "download"]);
    expect(more.items[0].heading).toBe("Share");
    expect(markup).not.toContain('data-tour="computer"');
    expect(markup).not.toContain('data-testid="usage-chip"');
  });
});

describe("header name", () => {
  it("renames only from the bot's settings: no pencil, and the whole pill opens them", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).not.toContain('aria-label="Rename Pepper"');
    const pill = markup.match(/<button[^>]*data-chathead-pill="true"[^>]*>([\s\S]*?)<\/button>/);
    expect(pill?.[0]).toContain('aria-label="Open Pepper&#x27;s profile"');
    expect(pill?.[1]).toContain(">Pepper</span>");
    expect(pill?.[0]).toContain("rounded-full");
  });

  it("centres the bot in the header's middle column, with the controls in the last", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const row = markup.match(/data-chathead-row="true" class="([^"]*)"/)?.[1] ?? "";
    expect(row).toContain("@min-[30rem]/chathead:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(max-content,1fr)]");
    expect(markup).toMatch(/data-chathead-identity="true" class="[^"]*@min-\[30rem\]\/chathead:col-start-2[^"]*justify-self-center/);
    expect(markup).toMatch(/data-chathead-controls="true" class="[^"]*@min-\[30rem\]\/chathead:col-start-3/);
  });
});

describe("a working dog in the header and the chat", () => {
  const inThread = (patch: Partial<Task>, messages: Message[] = []): Bot => ({ ...bot, messages, tasks: [{ ...bot.tasks![0]!, ...patch }] });
  const working = (messages: Message[] = []) => inThread({ busy: true, activity: "working" }, messages);
  const pill = (markup: string) => markup.match(/<button[^>]*data-chathead-pill="true"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
  const moods = (markup: string) => [...markup.matchAll(/data-mood="([a-z]+)"/g)].map((match) => match[1]);

  it("holds a still face in the header with no work dot, and leaves Stop to the composer", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: working() }));
    expect(pill(markup)).not.toContain("data-status=");
    expect(pill(markup)).toContain("data-paused");
    expect(pill(markup)).not.toContain("animate-status-pulse");
    expect(markup.match(/Stop this turn/g)).toHaveLength(1);
    expect(pill(renderToStaticMarkup(createElement(ChatView, { bot })))).not.toContain("working-dot");
  });

  it("keeps the dog idle while a send has not reached the server, held or not", () => {
    const leaving: Message = { id: "optimistic-s1", role: "user", kind: "text", text: "hi", at: 1 };
    expect(pill(renderToStaticMarkup(createElement(ChatView, { bot: inThread({}, [leaving]) })))).not.toContain("working-dot");
    expect(pill(renderToStaticMarkup(createElement(ChatView, { bot: inThread({}, [{ ...leaving, held: true }]) })))).not.toContain("working-dot");
  });

  it("shows an orange header dot only while the dog waits on you", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: inThread({ busy: true, activity: "waiting-on-you" }) }));
    expect(pill(markup)).toContain('data-testid="waiting-dot"');
    expect(pill(markup)).toContain("bg-waiting");
  });

  it("stops a wait on other dogs from the composer as well", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: inThread({ waitingForTeammates: true }) }));
    expect(markup).toContain("Other dogs working");
    expect(pill(markup)).not.toContain("working-dot");
    expect(markup.match(/Stop this turn/g)).toHaveLength(1);
  });

  it("works in the chat while a tool runs and thinks between tools, the sidebar's rule", () => {
    const asked: Message = { id: "q", role: "user", kind: "text", text: "go", at: 1 };
    const tool = (ok?: boolean): Message => ({ id: "t", role: "bot", kind: "activity", at: 2, tool: { name: "Bash", ...(ok === undefined ? {} : { ok }) } });
    expect(moods(renderToStaticMarkup(createElement(ChatView, { bot: working([asked, tool()]) })))).toEqual(["rest", "work"]);
    expect(moods(renderToStaticMarkup(createElement(ChatView, { bot: working([asked, tool(true)]) })))).toEqual(["rest", "think"]);
    expect(moods(renderToStaticMarkup(createElement(ChatView, { bot: working([asked]) })))).toEqual(["rest", "think"]);
  });
});

describe("glass header", () => {
  it("floats the header over the transcript, which starts below it and scrolls on underneath", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const frame = markup.indexOf("data-glass-frame");
    const header = markup.indexOf('data-glass-bar="top"');
    const name = markup.indexOf("data-chathead-row");
    const scroller = markup.indexOf('class="glass-scroller ');
    expect(frame).toBeGreaterThan(-1);
    expect(frame).toBeLessThan(header);
    expect(header).toBeLessThan(name);
    expect(name).toBeLessThan(scroller);
    expect(markup.slice(frame, header)).toContain("[--glass-tint:var(--color-app)]");
    expect(markup.slice(scroller)).toMatch(/class="glass-scroller-content[^"]*"[^>]*role="log"/);
  });
});

describe("thread control placement", () => {
  it("leaves All threads to the sidebar", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).not.toContain('aria-label="All threads"');
    expect(markup).toContain('data-testid="chat-find"');
    expect(markup).toContain('data-testid="chat-more"');
  });

  it("says in the chat when the dog needs your hands on its computer, with Open, unless its Computer tab is showing", () => {
    expect(renderToStaticMarkup(createElement(ChatView, { bot }))).not.toContain("data-needs-you");
    fixture.control = { [bot.id]: { held: false, helpReason: "Sign in to the site, then hand it back." } };
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).toContain("data-needs-you");
    expect(markup).toContain("Sign in to the site, then hand it back.");
    fixture.computerShown = true;
    expect(renderToStaticMarkup(createElement(ChatView, { bot }))).not.toContain("data-needs-you");
    fixture.control = {};
    fixture.computerShown = false;
  });

  it("always offers one voice button in the composer, never in the header, with no mode menu", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    const header = markup.slice(markup.indexOf("data-chathead-controls"), markup.indexOf("data-composer-row"));
    expect(header).not.toContain("data-call-button");
    const actions = markup.slice(markup.indexOf("data-composer-actions"));
    expect(actions).toContain("data-call-button");
    expect(markup.match(/data-call-button=/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-label="Call mode"');
  });

  it("gives the editor its own row in a narrow chat", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).toContain("@container/composer");
    const row = /data-composer-row="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(row[1]).toContain("@max-[30rem]/composer:flex-wrap");
    const editor = /class="mention-editor ([^"]*)"/.exec(markup)!;
    expect(editor[1].split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "@max-[30rem]/composer:order-first", "@max-[30rem]/composer:basis-full"]));
  });

  it("keeps the composer inert until the deleted thread's replacement transcript arrives", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, awaitingThreadSnapshot: true } }));
    expect(markup).toMatch(/<textarea[^>]*disabled=""[^>]*aria-busy="true"/);
  });

  it("explains provider safety errors without offering an ineffective Retry", () => {
    const markup = renderToStaticMarkup(createElement(ErrorRow, { message: "Blocked by our safety systems", onRetry: () => {} }));
    expect(markup).toContain("Full access controls tool approvals, not provider safety checks");
    expect(markup).not.toContain("<button");
    expect(renderToStaticMarkup(createElement(ErrorRow, { message: "Network timeout", onRetry: () => {} }))).toContain("<button");
  });
  it("directs ChatGPT plan limits to usage settings rather than repeatedly retrying", () => {
    const markup = renderToStaticMarkup(createElement(ErrorRow, { message: "ChatGPT plan usage limit reached (subscription_sharing_usage_limit_exceeded)", onRetry: () => {} }));
    expect(markup).toContain("Manage usage");
    expect(markup).toContain("https://chatgpt.com/settings/usage");
    expect(markup).not.toContain(">Retry<");
  });
  it("opens a signed-out engine's failed turn with one sentence and the sign-in, the CLI's words under Details", () => {
    const claude = {
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
      snapshot: { state: "available", authenticated: false },
      install: { command: { darwin: "x", linux: "x", win32: "x" }, signInCommand: "claude /login", server: { package: "@anthropic-ai/claude-code" } },
      authentication: { method: "paste-code" },
      models: { default: "sonnet", options: [] },
    } as InstanceInfo;
    const markup = renderToStaticMarkup(createElement(FailedTurnRow, { tool: { name: "error: Not logged in · Please run /login", ok: false, setup: true }, engine: claude, onRetry: () => {} }));
    expect(markup).toContain(">Claude isn&#x27;t signed in yet. Sign in below, then send your message again.</span>");
    expect(markup).toContain("Sign in to Claude</button>");
    expect(markup).toMatch(/<summary[^>]*>Details<\/summary><p[^>]*>Not logged in · Please run \/login<\/p>/);
    expect(markup).not.toContain(">Retry<");
    const update = { name: "error: Claude Code 2.1.268 does not support this model", ok: false, setup: true, claudeUpdate: true };
    for (const engine of [claude, { ...claude, readOnly: true }]) {
      const row = renderToStaticMarkup(createElement(FailedTurnRow, { tool: update, engine }));
      expect(row).toContain(">Claude Code 2.1.268 does not support this model</span>");
      expect(row).not.toContain("isn&#x27;t signed in");
      expect(activityPreview(update, engine)).toBe("Claude Code 2.1.268 does not support this model");
    }
  });
  it("offers to update Claude Code for a too-old install, or hands over the command", () => {
    const claude = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available", authenticated: true } } as InstanceInfo;
    const markup = renderToStaticMarkup(createElement(ErrorRow, {
      message: "API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required.",
      onRetry: () => {},
      setupInstance: claude,
      claudeUpdateInstance: claude,
    }));
    expect(markup).toContain("Update Claude for me");
    expect(markup).toContain("I&#x27;ll do it myself");
    expect(markup).not.toContain(">Retry<");
  });
  it("updates only a local Claude Code engine from chat", () => {
    const claude = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude" } as InstanceInfo;
    expect(claudeUpdateTarget(claude)).toBe(claude);
    expect(claudeUpdateTarget({ ...claude, readOnly: true })).toBeUndefined();
    expect(claudeUpdateTarget({ ...claude, driverKind: "codex" })).toBeUndefined();
    expect(claudeUpdateTarget(undefined)).toBeUndefined();
  });
  it("keeps Retry on the last failed turn after its digest, but never on an older turn", () => {
    const messages: Bot["messages"] = [
      { id: "ask", role: "user", kind: "text", at: 1, text: "Try the new model" },
      { id: "error", role: "bot", kind: "activity", at: 2, tool: { name: "error: outdated engine", ok: false } },
      { id: "digest", role: "bot", kind: "digest", at: 3, text: "no tool activity" },
    ];
    const render = () => renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false, messages } }));
    expect(render()).toContain("Retry</button>");
    messages.push({ id: "next", role: "user", kind: "text", at: 4, text: "A different request" });
    expect(render()).not.toContain("Retry</button>");
  });
  it.each([false, true])("keeps recovery visible and outside tool folds when tool calls are %s", (showToolCalls) => {
    fixture.showToolCalls = showToolCalls;
    const explanation = "Automatic recovery: Qwen could not start. Trying Backup · fixture-model once in this thread.";
    const messages: Bot["messages"] = [
      { id: "read", role: "bot", kind: "activity", at: 1, tool: { name: "Read", ok: true } },
      { id: "edit", role: "bot", kind: "activity", at: 2, tool: { name: "Edit", ok: true } },
      { id: "recovery", role: "bot", kind: "activity", at: 3, tool: { name: `recovery: ${explanation}`, ok: true } },
      { id: "bash", role: "bot", kind: "activity", at: 4, tool: { name: "Bash", ok: true } },
      { id: "write", role: "bot", kind: "activity", at: 5, tool: { name: "Write", ok: true } },
    ];
    try {
      const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false, messages } }));
      expect(markup).toContain('data-mid="recovery"><div role="status"');
      expect(markup).toContain(explanation);
      expect(markup).not.toContain(`recovery: ${explanation}`);
      expect(markup.match(/Automatic recovery:/g)).toHaveLength(1);
      if (!showToolCalls) expect(markup).not.toContain('data-testid="tool-activity"');
    } finally {
      fixture.showToolCalls = false;
    }
  });
  it.each([false, true])("shows a model notice as a status row when tool calls are %s", (showToolCalls) => {
    fixture.showToolCalls = showToolCalls;
    const explanation = "OpenCode no longer offers opencode/x-preview-f-free, so this conversation uses opencode/big-pickle.";
    const messages: Bot["messages"] = [
      { id: "read", role: "bot", kind: "activity", at: 1, tool: { name: "Read", ok: true } },
      { id: "notice", role: "bot", kind: "activity", at: 2, tool: { name: `notice: ${explanation}`, ok: true } },
      { id: "bash", role: "bot", kind: "activity", at: 3, tool: { name: "Bash", ok: true } },
      { id: "reply", role: "bot", kind: "text", at: 4, text: "ok" },
    ];
    try {
      const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false, messages } }));
      expect(markup).toContain('data-mid="notice"><div role="status"');
      expect(markup.match(/no longer offers/g)).toHaveLength(1);
      expect(markup).not.toContain(`notice: ${explanation}`);
      if (!showToolCalls) expect(markup).not.toContain('data-testid="tool-activity"');
    } finally {
      fixture.showToolCalls = false;
    }
  });

  it("offers the matching macOS Settings and relaunch actions only for a named CUA permission failure", () => {
    fixture.platform = "darwin";
    fixture.localMessage = "Screen Recording required";
    window.laterdog = { platform: "darwin", permOpenSettings: vi.fn(), relaunch: vi.fn() } as unknown as NonNullable<Window["laterdog"]>;
    const screen = renderToStaticMarkup(createElement(ErrorRow, {
      message: "CUA Driver is not ready for this computer — embedded host failed: Screen Recording required. Relaunch later.dog after granting any missing macOS permission.",
    }));
    expect(screen).toContain("Open Screen Recording Settings");
    expect(screen).toContain("Relaunch later.dog");
    expect(screen).not.toContain("Open Accessibility Settings");
    fixture.localMessage = "Accessibility required";
    const accessibility = renderToStaticMarkup(createElement(ErrorRow, {
      message: "CUA Driver is not ready for this computer — Accessibility required",
    }));
    expect(accessibility).toContain("Open Accessibility Settings");
    expect(accessibility).not.toContain("Open Screen Recording Settings");
    expect(renderToStaticMarkup(createElement(ErrorRow, {
      message: "CUA Driver is not ready for this computer — Screen Recording required",
    }))).not.toContain("Open Screen Recording Settings");
    expect(renderToStaticMarkup(createElement(ErrorRow, { message: "Network timeout" }))).not.toContain("Open Screen Recording Settings");
    fixture.localReasonCode = "remote-server";
    expect(renderToStaticMarkup(createElement(ErrorRow, { message: "CUA Driver is not ready for this computer — Screen Recording required" }))).not.toContain("Open Screen Recording Settings");
    fixture.localReasonCode = "cua-driver-unavailable";
    fixture.platform = "other";
    fixture.localMessage = "";
    delete window.laterdog;
  });
  it.each([
    "شغّل الاختبارات\nThen run typecheck\nوبعدها ارفع الفرع",
    "שלום עולם\nThen run typecheck\nתודה רבה",
    `${"مرحبا\n".repeat(10)}Then run typecheck`,
  ])("applies per-line direction to the actual user text, including collapsed messages", (text) => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: {
      ...bot,
      messages: [{ id: "mixed-script", role: "user", kind: "text", at: 1, text }],
    } }));
    expect(markup).toMatch(/<div class="chat-text[^"]*"[^>]*>(?:شغّل|שלום|مرحبا)/);
    expect(markup).not.toMatch(/class="[^"]*chat-text[^"\n]*bg-bubble-user/);
  });

  it("wraps the header into a name line and a chip line when the column is narrow", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false } }));
    expect(markup).toContain("@container/chathead");
    const row = /data-chathead-row="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(row[1].split(" ")).toContain("@max-[30rem]/chathead:flex-wrap");
    const identity = /data-chathead-identity="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(identity[1].split(" ")).toEqual(expect.arrayContaining(["min-w-0", "@max-[30rem]/chathead:basis-full"]));
    const controls = /data-chathead-controls="[^"]*" class="([^"]*)"/.exec(markup)!;
    expect(controls[1].split(" ")).toEqual(expect.arrayContaining(["shrink-0", "@max-[30rem]/chathead:ml-auto", "@max-[30rem]/chathead:flex-wrap"]));
  });

  it("shows no crown or main dog label in the chat header", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, busy: false, chiefOfStaff: true } }));
    expect(markup).not.toContain("lucide-crown");
    expect(markup).not.toContain("Chief of Staff");
    expect(markup).not.toContain('data-testid="main-dog-badge"');
  });

  it("keeps the account in the header and puts the model inside the composer pill, with no permissions there", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup.match(/data-test-model-control/g)).toHaveLength(2);
    expect(markup.indexOf("data-test-model-control")).toBeLessThan(markup.indexOf('role="log"'));
    expect(markup.lastIndexOf("data-test-model-control")).toBeGreaterThan(markup.indexOf("data-composer-actions"));
    expect(markup.indexOf('data-tour="composer"')).toBeGreaterThan(-1);
    expect(markup.indexOf("data-composer-actions")).toBeGreaterThan(markup.indexOf("<textarea"));
    expect(markup).not.toContain("data-test-approval-control");
    expect(markup).not.toContain('aria-label="Thread settings"');
    expect(fixture.model).toMatchObject({ threadId: "selected", bot: { busy: false, modelSelection: { model: "thread-model" } } });
  });

  it("pins no place per conversation: the chat follows the bot's Works on", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).not.toContain('data-testid="place-chip"');
    expect(markup).not.toContain("Where this conversation works");
  });
});

describe("screen reader announcements", () => {
  it("keeps the transcript log out of live announcements", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup).toMatch(/role="log" aria-live="off" aria-label="Conversation with Pepper"/);
  });

  it("does not make the working label a second live region", async () => {
    const { TurnPresence } = await import("./TurnPresence");
    const markup = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, label: "Running a command", since: 1, showDelayMs: 0 }));
    expect(markup).toContain("Running a command");
    expect(markup).not.toMatch(/thinking-shimmer[^"]*" aria-live/);
  });

  it("renders one visually hidden status line for finished replies", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup.match(/data-testid="transcript-announcer"/g)).toHaveLength(1);
    expect(markup).toMatch(/<p role="status" aria-live="polite" aria-atomic="true" class="sr-only" data-testid="transcript-announcer">/);
  });
});

describe("a guest's composer on a Cloud home", () => {
  it("takes the composer's place with one plain sentence only where the device may not write", () => {
    fixture.canWrite = false;
    const refused = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(refused).toContain('data-testid="cloud-guest-composer"');
    expect(refused).toContain("You can only write in conversations you started on this Cloud.");
    expect(refused).not.toContain("New conversation");
    expect(refused).not.toContain("<textarea");
    expect(refused).not.toContain('data-testid="citation-toolbar"');
    fixture.canWrite = true;
    const allowed = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(allowed).not.toContain('data-testid="cloud-guest-composer"');
    expect(allowed).toContain("<textarea");
    expect(allowed).toContain('data-testid="citation-toolbar"');
    fixture.canWrite = null;
  });
});
