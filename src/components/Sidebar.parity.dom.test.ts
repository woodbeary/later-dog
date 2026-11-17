// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type Bot } from "@/state/store";
import { helpersLine, stepPhrase } from "../../shared/step-words";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

const { BotListItem, botRowProps } = await import("./Sidebar");
const { setLocale, t } = await import("@/lib/i18n");

const dog = (patch: Partial<Bot> & { step?: unknown } = {}): Bot => ({
  id: "juniper",
  threadId: "thread-juniper",
  name: "Juniper",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "test", model: "m" },
  messages: [],
  ...patch,
} as Bot);

let root: Root | null = null;
let host: HTMLElement | null = null;

function draw(bot: Bot, density: "comfortable" | "icons" = "comfortable", selected = false): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const state = { ...initialState, selectedId: selected ? bot.id : "" };
  flushSync(() => root!.render(createElement(BotListItem, botRowProps(state, vi.fn(), bot, { density, onMenu: vi.fn() }))));
  return host.querySelector<HTMLElement>("[data-sidebar-bot-row]")!;
}

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

const preview = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-row-preview]")!;
const dots = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>("[data-row-dot]")];
const step = { id: "run-9:tool-3", kind: "running", startedAt: 1, lastActivityAt: 2 } as const;

describe("a dog's row in the sidebar", () => {
  it("says the working dog's step in the same words as its chat line", () => {
    const row = draw(dog({ busy: true, activity: "working", step }));
    expect(preview(row).textContent).toBe(stepPhrase(step.kind, step.id));
    expect(row.getAttribute("aria-label")).toBe(`Juniper · ${stepPhrase(step.kind, step.id)}`);
  });

  it("shows one green dot on the face for a working dog, and no animated dots", () => {
    const row = draw(dog({ busy: true, activity: "working", step, unread: true }));
    expect(dots(row).map((dot) => dot.dataset.rowDot)).toEqual(["working"]);
    expect(dots(row)[0]!.className).toContain("bg-working");
    expect(row.querySelector(".animate-status-pulse")).toBeNull();
  });

  it("puts the dog's ask under its name in amber, over two lines", () => {
    const ask = { id: "q1", role: "bot" as const, kind: "options" as const, at: 1, card: { title: "Which photo should lead the menu?", subtitle: "", options: [] } };
    const row = draw(dog({ activity: "waiting-on-you", busy: true, messages: [ask] as Bot["messages"] }));
    expect(preview(row).className).toContain("text-waiting-text");
    expect(preview(row).className).toContain("line-clamp-2");
    expect(dots(row).map((dot) => dot.dataset.rowDot)).toEqual(["waiting"]);
  });

  it("says the dog's open question itself as its ask", () => {
    const question = "Should I move Friday's dinner to Saturday at seven, or keep Friday and ask for a later table?";
    const asked = { id: "q2", role: "bot" as const, kind: "options" as const, at: 2, card: { title: "A question", subtitle: "", options: [], requestType: "question" as const, questionRequest: { version: 1 as const, questions: [{ question, options: [] }] } } };
    expect(preview(draw(dog({ activity: "waiting-on-you", busy: true, messages: [asked] as Bot["messages"] }))).textContent).toBe(question);
    const plain = { id: "q3", role: "bot" as const, kind: "options" as const, at: 3, card: { title: "Which photo should lead the menu?", subtitle: "", options: ["The terrace", "The kitchen"] } };
    expect(preview(draw(dog({ activity: "waiting-on-you", busy: true, messages: [plain] as Bot["messages"] }))).textContent).toBe("Which photo should lead the menu?");
  });

  it("names the helper a coordinator waits on for your answer, in amber on one line", () => {
    const row = draw(dog({ waitingForTeammates: true, waitingOn: [{ botId: "otis", name: "Otis", state: "needsYou" }] }));
    expect(preview(row).textContent).toBe(helpersLine([{ name: "Otis", state: "needsYou" }])!.text);
    expect(preview(row).className).toContain("text-waiting-text");
    expect(preview(row).className).toContain("truncate");
    expect(dots(row).map((dot) => dot.dataset.rowDot)).toEqual(["working"]);
  });

  it("keeps the translated waiting line for a coordinator in other languages until the helper words are translated", () => {
    const waitingOn = [{ botId: "otis", name: "Otis", state: "needsYou" as const }];
    setLocale("es");
    try {
      const row = draw(dog({ waitingForTeammates: true, waitingOn }));
      expect(preview(row).textContent).toBe(t("sidebar.preview.waitingOnTeammate"));
      expect(preview(row).textContent).toBe("Esperando a otro perro…");
    } finally {
      setLocale("en");
    }
    root?.unmount();
    host?.remove();
    const english = draw(dog({ waitingForTeammates: true, waitingOn }));
    expect(preview(english).textContent).toBe("Otis needs your answer");
  });

  it("shows a blue dot at the end of a still dog's unread row", () => {
    const row = draw(dog({ unread: true, messages: [{ id: "m", role: "bot", kind: "text", text: "Here's this week's summary.", at: 1 }] }));
    expect(dots(row).map((dot) => dot.dataset.rowDot)).toEqual(["unread"]);
    expect(preview(row).textContent).toBe("Here's this week's summary.");
    expect(preview(row).className).not.toContain("text-waiting-text");
  });

  it("draws no dot for a still dog with nothing new", () => {
    expect(dots(draw(dog()))).toEqual([]);
  });

  it("keeps the same one dot on the face in the narrow rail", () => {
    const row = draw(dog({ busy: true, step }), "icons");
    expect(dots(row).map((dot) => dot.dataset.rowDot)).toEqual(["working"]);
    expect(row.querySelector("[data-row-preview]")?.closest(".hidden")).not.toBeNull();
  });

  it("lays the row out at 52 high with a 32 face, an 8 dot in a 2 ring, 14/20 name and 13/17 preview", () => {
    const row = draw(dog({ busy: true, step }), "comfortable", true);
    expect(row.className).toMatch(/\bmin-h-\[52px\]/);
    expect(row.className).toMatch(/\bpy-2\b/);
    expect(row.className).toMatch(/\bpx-2\.5\b/);
    expect(row.className).toMatch(/\bbg-card\b/);
    expect(row.className).toMatch(/\brounded-row\b/);
    const face = row.querySelector<HTMLElement>("[data-row-face]")!;
    expect([face.style.width, face.style.height]).toEqual(["32px", "32px"]);
    const dot = dots(row)[0]!;
    expect(dot.className).toMatch(/\bsize-3\b/);
    expect(dot.className).toMatch(/\bborder-2\b/);
    const name = row.querySelector<HTMLElement>("[data-row-name]")!;
    expect(name.className).toMatch(/text-\[14px\].*leading-5.*font-medium|font-medium.*text-\[14px\].*leading-5/);
    expect(preview(row).parentElement!.className).toMatch(/text-\[13px\]/);
    expect(preview(row).parentElement!.className).toMatch(/leading-\[17px\]/);
  });
});
