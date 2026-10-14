import { describe, expect, it } from "vitest";
import {
  GENERIC_MESSAGE,
  TOO_SLOW_MESSAGE,
  UNREACHABLE_MESSAGE,
  plainClientError,
  statusFallback,
} from "./plain-client-error";

describe("errors the person reads", () => {
  it("says a lost connection in words in every browser's wording", () => {
    for (const message of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource.", "The network connection was lost.", "fetch failed"]) {
      expect(plainClientError(new TypeError(message))).toBe(UNREACHABLE_MESSAGE);
    }
    expect(UNREACHABLE_MESSAGE).not.toMatch(/fetch|TypeError|network error/i);
  });

  it("says a slow answer in words", () => {
    expect(plainClientError(Object.assign(new Error("signal timed out"), { name: "TimeoutError" }))).toBe(TOO_SLOW_MESSAGE);
    expect(plainClientError(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }))).toBe(TOO_SLOW_MESSAGE);
  });

  it("keeps a message the server wrote for the person, and never shows an empty one", () => {
    expect(plainClientError(new Error("Your Mac is almost out of space, so later.dog couldn't save that."))).toBe("Your Mac is almost out of space, so later.dog couldn't save that.");
    expect(plainClientError(new Error(""))).toBe(GENERIC_MESSAGE);
    expect(plainClientError(undefined)).toBe(GENERIC_MESSAGE);
    expect(plainClientError("already a sentence")).toBe("already a sentence");
  });

  it("explains a bare gateway or server status instead of printing its code and name", () => {
    expect(statusFallback(502)).toMatch(/isn't answering right now/);
    expect(statusFallback(503)).toMatch(/isn't answering right now/);
    expect(statusFallback(500)).toBe(GENERIC_MESSAGE);
    expect(statusFallback(404)).toMatch(/isn't there any more/);
    expect(statusFallback(409)).toBe(GENERIC_MESSAGE);
    expect(statusFallback(401)).toMatch(/didn.t accept that/);
  });
});
