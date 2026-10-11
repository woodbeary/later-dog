import { describe, expect, it } from "vitest";

import { useShowThreads } from "./thread-preferences";

describe("threads in the sidebar", () => {
  it("are always listed, whatever an earlier version stored", () => {
    globalThis.localStorage?.setItem("laterdog-show-threads", "0");
    expect(useShowThreads()).toBe(true);
  });
});
