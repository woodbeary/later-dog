import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ effects: [] as EffectCallback[], pair: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: (effect: EffectCallback) => { f.effects.push(effect); } }));
vi.mock("../lib/session", async original => ({ ...await original<typeof import("../lib/session")>(), pairWithCode: f.pair, readSessionState: vi.fn().mockResolvedValue({ kind: "unauthenticated", error: "" }) }));
import { PairPage, pairIntro } from "./PairPage";
import en from "../locales/en.json";

const code = "ABCD-EFGH-JK23";
const render = (initialCode: string | null) => { f.effects = []; return renderToStaticMarkup(createElement(PairPage, { initialCode })); };

beforeEach(() => {
  f.pair.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
});
afterEach(() => vi.unstubAllGlobals());

it("a browser keeps the code in the form for the person to confirm", () => {
  vi.stubGlobal("window", {});
  const html = render(code);
  expect(html).toContain(`value="${code}"`); expect(html).toContain(">Connect</button>");
  f.effects[0]?.(); expect(f.pair).not.toHaveBeenCalled();
});

it("My Cloud says where its connection starts, never 'the code shown on the server'", () => {
  const cloud = pairIntro({ mode: "code", sent: false, email: "", cloudHome: true });
  expect(cloud).toContain(`choose ${en["cloudHome.connect"]} in the later.dog app`);
  expect(cloud).not.toContain("Settings →");
  expect(cloud).toContain("on your Plan page");
  expect(cloud).not.toContain("shown on the server");
  expect(pairIntro({ mode: "code", sent: false, email: "", cloudHome: false })).toContain("shown on the server");
  expect(pairIntro({ mode: "email", sent: true, email: "a@b.test", cloudHome: false })).toContain("a@b.test");
});
