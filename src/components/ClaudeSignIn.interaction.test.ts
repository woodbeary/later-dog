import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as (() => (() => void) | undefined)[],
  api: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(), openExternal: vi.fn(), signedIn: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
  useEffect: (effect: () => (() => void) | undefined) => { fixture.effects.push(effect); },
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(), api: fixture.api,
  useStore: () => ({ refreshInstances: fixture.refreshInstances, refreshModels: fixture.refreshModels }),
}));
const { ApiError } = await import("@/state/store");
const { ClaudeSignIn } = await import("./ClaudeSignIn");

type Node = ReactElement<{ children?: ReactNode; onClick?: () => Promise<void>; onChange?: (event: { target: { value: string } }) => void }>;
function nodes(tree: ReactNode): Node[] {
  return Children.toArray(tree).flatMap((child) => isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []);
}
function render() {
  fixture.index = 0;
  fixture.effects = [];
  return nodes(ClaudeSignIn({ instanceId: "claude-work", onSignedIn: fixture.signedIn }));
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const waiting = {
  phase: "waiting", flowId: "flow-one", authorizationUrl: "https://claude.ai/oauth/authorize?state=fixture",
  expiresAt: "2030-01-01T00:10:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  vi.clearAllMocks();
  fixture.values = [];
  vi.stubGlobal("window", { setTimeout, clearTimeout, laterdog: { openExternal: fixture.openExternal } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("takes the outcome from auth/complete, so a finished flow the server forgot still reads as signed in", async () => {
  fixture.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/auth/start")) return { auth: waiting };
    if (path.endsWith("/auth/complete")) return { ok: true, auth: { ...waiting, phase: "succeeded" } };
    // the completed flow is gone: this is what the server answers today
    throw new ApiError(404, "unknown sign-in flow");
  });
  render().find((node) => node.type === "button")!.props.onClick!();
  await flush();
  expect(fixture.api).toHaveBeenCalledWith("/api/instances/claude-work/auth/start", { method: "POST" });
  const input = render().find((node) => node.type === "input")!;
  input.props.onChange!({ target: { value: " abcdefgh-code " } });
  const finish = render().find((node) => node.type === "button" && String(node.props.children).includes("Finish") || (node.type === "button" && nodes(node.props.children).length > 0 && String(node.props.children).includes("Finish")));
  const finishButton = finish ?? render().filter((node) => node.type === "button")[0]!;
  finishButton.props.onClick!();
  await flush();
  expect(fixture.api).toHaveBeenCalledWith("/api/instances/claude-work/auth/complete", { method: "POST", body: JSON.stringify({ flowId: "flow-one", code: "abcdefgh-code" }) });
  expect(fixture.values[0]).toMatchObject({ phase: "succeeded" });
  expect(fixture.refreshInstances).toHaveBeenCalledOnce();
  expect(fixture.refreshModels).toHaveBeenCalledWith("claude-work");
  expect(fixture.signedIn).toHaveBeenCalledOnce();
});

it("shows the server's refusal of a wrong code without pretending the flow ended", async () => {
  fixture.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/auth/start")) return { auth: waiting };
    if (path.endsWith("/auth/complete")) return { ok: true, auth: { ...waiting, phase: "failed", message: "That code was not accepted." } };
    throw new ApiError(404, "unknown sign-in flow");
  });
  render().find((node) => node.type === "button")!.props.onClick!();
  await flush();
  render().find((node) => node.type === "input")!.props.onChange!({ target: { value: "abcdefgh-code" } });
  render().filter((node) => node.type === "button")[0]!.props.onClick!();
  await flush();
  expect(fixture.values[0]).toMatchObject({ phase: "failed", message: "That code was not accepted." });
  expect(fixture.refreshInstances).not.toHaveBeenCalled();
  expect(fixture.signedIn).not.toHaveBeenCalled();
});
