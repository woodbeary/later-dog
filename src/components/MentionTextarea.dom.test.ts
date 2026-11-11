// @vitest-environment happy-dom
import { act, createElement, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MentionTextarea } from "./MentionTextarea";

const LINE = 24;
const PADDING = 8;
const ONE_LINE = LINE + PADDING;

let host: HTMLDivElement;
let root: Root;
let inputRef: RefObject<HTMLTextAreaElement | null>;
let heightsSet: string[];
let width: number;
let widthChanged: () => void;

function boxHeight(input: HTMLTextAreaElement): number {
  const height = input.style.height;
  return height === "" || height === "auto" ? ONE_LINE : parseFloat(height);
}

function textHeight(input: HTMLTextAreaElement): number {
  return input.value.split("\n").length * LINE + PADDING;
}

function shown(value: string) {
  act(() => root.render(createElement(MentionTextarea, { inputRef, peers: [], value, rows: 1, readOnly: true })));
}

function measuredSince<T>(work: () => T): number {
  const before = heightsSet.length;
  work();
  return heightsSet.slice(before).filter((height) => height === "auto").length;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  heightsSet = [];
  width = 600;
  vi.stubGlobal("ResizeObserver", class {
    constructor(heard: () => void) { widthChanged = heard; }
    observe() {}
    disconnect() {}
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  inputRef = createRef<HTMLTextAreaElement>();
  shown("");
  const input = inputRef.current!;
  const style = input.style;
  Object.defineProperty(input, "style", { value: new Proxy(style, {
    get: (target, name) => Reflect.get(target, name),
    set: (target, name, next) => {
      if (name === "height") heightsSet.push(String(next));
      return Reflect.set(target, name, next);
    },
  }) });
  Object.defineProperty(input, "clientWidth", { get: () => width });
  Object.defineProperty(input, "clientHeight", { get: () => boxHeight(input) });
  Object.defineProperty(input, "scrollHeight", { get: () => Math.max(textHeight(input), boxHeight(input)) });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("does not measure a one-line message box again on each key while the text fits", () => {
  shown("C");
  expect(measuredSince(() => { for (const text of ["Ca", "Can", "Can ", "Can y", "Ca", ""]) shown(text); })).toBe(0);
  expect(boxHeight(inputRef.current!)).toBe(ONE_LINE);
});

it("grows with each new line up to six lines and then stays", () => {
  shown("one");
  expect(measuredSince(() => shown("one\ntwo"))).toBe(1);
  expect(boxHeight(inputRef.current!)).toBe(2 * LINE + PADDING);
  expect(measuredSince(() => shown("one\ntwo and more"))).toBe(0);
  shown("one\ntwo and more\n3\n4\n5\n6\n7");
  expect(boxHeight(inputRef.current!)).toBe(6 * LINE);
  expect(measuredSince(() => { shown("one\ntwo and more\n3\n4\n5\n6\n7\n8"); shown("one\ntwo and more\n3\n4\n5\n6\n7\n8\n9"); })).toBe(0);
  expect(boxHeight(inputRef.current!)).toBe(6 * LINE);
});

it("shrinks when lines are removed, and back to one line when the text is cleared", () => {
  shown("one\ntwo\nthree");
  expect(boxHeight(inputRef.current!)).toBe(3 * LINE + PADDING);
  shown("one\ntwo");
  expect(boxHeight(inputRef.current!)).toBe(2 * LINE + PADDING);
  shown("one two");
  expect(boxHeight(inputRef.current!)).toBe(ONE_LINE);
  shown("1\n2\n3\n4\n5\n6\n7\n8");
  shown("");
  expect(boxHeight(inputRef.current!)).toBe(ONE_LINE);
});

it("measures again when the box changes width", () => {
  shown("one\ntwo");
  width = 480;
  expect(measuredSince(() => act(() => widthChanged()))).toBe(1);
  expect(measuredSince(() => act(() => widthChanged()))).toBe(0);
});
