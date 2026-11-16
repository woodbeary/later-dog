// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveCommandDialog } from "./SaveCommandDialog";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function mount(props: Parameters<typeof SaveCommandDialog>[0], answer: { status: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(SaveCommandDialog, props)));
  const dialog = document.querySelector<HTMLElement>("[data-save-command]")!;
  const name = dialog.querySelector("input")!;
  const text = dialog.querySelector("textarea")!;
  const button = (label: string) => [...dialog.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
  const typeName = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, value);
    flushSync(() => name.dispatchEvent(new Event("input", { bubbles: true })));
  };
  return { root, dialog, name, text, button, typeName, calls };
}

describe("saving a command", () => {
  it("starts from a sent message, suggests a name, and saves it on the home", async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const view = mount(
      { initialText: "Split the work: you plan, helpers build.", onClose, onSaved },
      { status: 201, body: { command: { name: "split", text: "Split the work: you plan, helpers build.", updatedAt: 1 } } },
    );
    expect(view.name.value).toBe("split-the-work");
    expect(view.text.value).toBe("Split the work: you plan, helpers build.");
    view.typeName("/Split");
    flushSync(() => view.button("Save").click());
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(view.calls).toEqual([{ url: "/api/commands", method: "POST", body: { name: "split", text: "Split the work: you plan, helpers build." } }]);
    expect(onSaved).toHaveBeenCalledWith({ name: "split", text: "Split the work: you plan, helpers build.", updatedAt: 1 });
    view.root.unmount();
  });

  it("keeps Save off for a name it cannot use", () => {
    const view = mount({ initialText: "Plan first.", onClose: vi.fn() }, { status: 201, body: {} });
    view.typeName("two words");
    expect(view.button("Save").disabled).toBe(true);
    expect(view.dialog.textContent).toContain("Use up to 32 lowercase letters, digits or dashes.");
    view.root.unmount();
  });

  it("renames, rewrites or deletes one the person already has", async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const view = mount({ editing: { name: "plan", text: "Plan first." }, onClose, onSaved }, { status: 200, body: { ok: true } });
    expect(view.button("Save").disabled).toBe(true);
    flushSync(() => view.button("Delete").click());
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(view.calls).toEqual([{ url: "/api/commands/plan", method: "DELETE" }]);
    expect(onSaved).toHaveBeenCalledWith(null);
    view.root.unmount();
  });
});
