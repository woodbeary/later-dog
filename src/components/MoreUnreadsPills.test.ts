import { describe, expect, it } from "vitest";

import { unreadsOutOfView } from "./MoreUnreadsPills";

describe("More unreads", () => {
  it("counts unread rows hidden above and below the visible part of the list", () => {
    const view = { top: 100, bottom: 400 };
    const rows = [
      { top: 10, bottom: 60 },
      { top: 60, bottom: 100 },
      { top: 90, bottom: 140 },
      { top: 380, bottom: 430 },
      { top: 400, bottom: 450 },
      { top: 600, bottom: 650 },
    ];
    expect(unreadsOutOfView(rows, view)).toEqual({ above: 2, below: 2 });
    expect(unreadsOutOfView([], view)).toEqual({ above: 0, below: 0 });
  });
});
