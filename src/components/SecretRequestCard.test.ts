import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, dispatch: vi.fn(), api: vi.fn() }));
const dispatch = fixture.dispatch;
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (value: unknown) => { fixture.values[index] = value; }];
  },
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ dispatch }),
  api: fixture.api,
}));

import { SecretRequestCard } from "./SecretRequestCard";

const secretCard = (secret: Record<string, unknown>): Message => ({
  id: "secret-card",
  role: "bot",
  kind: "secret",
  at: 1,
  text: "Securely provide the OpenAI API key.",
  secret: {
    target: "openaiImageApiKey",
    label: "OpenAI API key",
    description: "Generate a key at platform.openai.com. Scout can use it but never read it back.",
    placeholder: "sk-…",
    helpUrl: "https://platform.openai.com/api-keys",
    requestKey: "request-key-1",
    ...secret,
  },
});

type Node = ReactElement<{
  children?: ReactNode;
  value?: string;
  disabled?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: { preventDefault(): void }) => void;
}>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render(secret: Record<string, unknown>) {
  fixture.index = 0;
  let tree: ReactNode = null;
  function Capture() {
    tree = SecretRequestCard({ botId: "bot-1", threadId: "thread-1", message: secretCard(secret) });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const view = (secret: Record<string, unknown>) => render(secret).html;
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

beforeEach(() => {
  vi.stubGlobal("window", {});
  dispatch.mockReset();
  fixture.api.mockReset();
  fixture.values = [];
  setLocale("en");
});

describe("SecretRequestCard superseded requests", () => {
  it("still offers entry while the newest request is pending", () => {
    const html = view({});
    expect(html).toContain("Save securely");
    expect(html).toContain("Never shown in chat.");
  });

  it("stops offering entry and names its replacement once superseded", () => {
    const html = view({ superseded: true });
    expect(html).toContain("Replaced");
    expect(html).toContain("replaced by a newer one for the same key");
    expect(html).toContain("Replaced by a newer request");
    expect(html).not.toContain("Save securely");
    expect(html).not.toContain("type=\"password\"");
    expect(html).not.toContain("Not now");
    expect(html).not.toContain("Waiting to resume safely");
  });
});


describe("SecretRequestCard save recovery", () => {
  it("keeps the key after a rejected save, hides the IPC error and saves again without re-entry", async () => {
    const setCredential = vi.fn().mockRejectedValueOnce(new Error("Error invoking remote method 'credential:set': Error: The credential store could not be read on this launch, so credentials cannot be saved"));
    window.laterdog = { setCredential } as unknown as Window["laterdog"];
    render({}).nodes.find((node) => node.type === "input")!.props.onChange!({ target: { value: "fixture-private-key" } });
    render({}).nodes.find((node) => node.type === "form")!.props.onSubmit!({ preventDefault: vi.fn() });
    expect(render({}).nodes.find((node) => node.type === "input")!.props.disabled).toBe(true);
    await flush();
    let result = render({});
    expect(result.nodes.find((node) => node.type === "input")!.props.value).toBe("fixture-private-key");
    expect(result.nodes.find((node) => node.type === "input")!.props.disabled).toBe(false);
    expect(result.html).toContain("The key could not be saved securely");
    expect(result.html).toContain("Retry");
    expect(result.html).not.toContain("Error invoking remote method");
    expect(fixture.api).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    const status = { ttsKeySet: true };
    setCredential.mockResolvedValueOnce(status);
    fixture.api.mockResolvedValueOnce({});
    result.nodes.find((node) => node.type === "form")!.props.onSubmit!({ preventDefault: vi.fn() });
    await flush();
    expect(setCredential).toHaveBeenCalledTimes(2);
    expect(setCredential).toHaveBeenLastCalledWith("openaiImageApiKey", "fixture-private-key");
    expect(dispatch).toHaveBeenCalledWith({ type: "configStatus", config: status });
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/bot-1/secret-cards/secret-card/provided", { method: "POST", body: JSON.stringify({ threadId: "thread-1" }) });
    result = render({});
    expect(result.nodes.find((node) => node.type === "input")!.props.value).toBe("");
    expect(result.html).toContain("Continue task");
  });

  it("does not re-save a key when only notifying the dog needs another try", async () => {
    const setCredential = vi.fn().mockResolvedValue({});
    window.laterdog = { setCredential } as unknown as Window["laterdog"];
    fixture.api.mockRejectedValueOnce(new Error("The dog could not resume"));
    render({}).nodes.find((node) => node.type === "input")!.props.onChange!({ target: { value: "fixture-private-key" } });
    render({}).nodes.find((node) => node.type === "form")!.props.onSubmit!({ preventDefault: vi.fn() });
    await flush();
    const result = render({});
    expect(result.html).toContain("The dog could not resume");
    expect(result.html).not.toContain("The key could not be saved");
    expect(result.nodes.find((node) => node.type === "input")!.props.value).toBe("");
    fixture.api.mockResolvedValueOnce({});
    result.nodes.find((node) => node.type === "form")!.props.onSubmit!({ preventDefault: vi.fn() });
    await flush();
    expect(setCredential).toHaveBeenCalledOnce();
    expect(fixture.api).toHaveBeenCalledTimes(2);
  });
});
