import { describe, expect, it } from "vitest";
import {
  GENERIC_MESSAGE,
  TOO_SLOW_MESSAGE,
  UNREACHABLE_MESSAGE,
  isBareCode,
  plainClientError,
  statusFallback,
} from "./plain-client-error";
import { HOME_WAKE_WORDS } from "../../shared/home-wake";

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

  it("never shows a bare code or status, and says a waking home in words", () => {
    const apiError = (message: string, status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name: "ApiError", status, ...extra });
    expect(plainClientError(apiError("waking", 503))).toBe(HOME_WAKE_WORDS.waking);
    expect(plainClientError(apiError("", 503, { wake: "busy" }))).toBe(HOME_WAKE_WORDS.busy);
    expect(plainClientError(apiError("spend_cap", 409))).toBe(GENERIC_MESSAGE);
    expect(plainClientError(apiError("not_found", 404))).toMatch(/isn't there any more/);
    expect(plainClientError(new Error("503"))).toMatch(/isn't answering right now/);
    expect(plainClientError(new Error("HTTP 502 Bad Gateway"))).toMatch(/isn't answering right now/);
    expect(plainClientError(new Error("SAND-E0703"))).toBe(GENERIC_MESSAGE);
    expect(plainClientError(apiError("Your home is taking longer than usual to wake up. Try again in a minute.", 503, { wake: "waking" }))).toMatch(/longer than usual/);
    expect(isBareCode("Your Mac is almost out of space.")).toBe(false);
    expect(isBareCode("spend_cap")).toBe(true);
  });
});
