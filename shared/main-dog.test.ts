import { describe, expect, it } from "vitest";

import { mainDogId } from "./main-dog.ts";

describe("mainDogId", () => {
  const dogs = [
    { id: "newest", createdAt: 30 },
    { id: "hidden-oldest", createdAt: 10, hidden: true },
    { id: "oldest-visible", createdAt: 20 },
  ];

  it("keeps the pointer while it names a dog, even a hidden one", () => {
    expect(mainDogId(dogs, "hidden-oldest")).toBe("hidden-oldest");
    expect(mainDogId(dogs, "newest")).toBe("newest");
  });

  it("falls back to the oldest visible dog when there is no chief and no pointer", () => {
    expect(mainDogId(dogs)).toBe("oldest-visible");
    expect(mainDogId(dogs, "deleted")).toBe("oldest-visible");
    expect(mainDogId([{ id: "only", hidden: true }])).toBe("only");
    expect(mainDogId([])).toBeNull();
  });

  it("prefers a visible saved chief, the unsectioned one first, then by sidebar order", () => {
    const chiefs = [
      ...dogs,
      { id: "ops-chief", section: "Ops", chiefOfStaff: true, createdAt: 40 },
      { id: "sales-chief", section: "Sales", chiefOfStaff: true, createdAt: 50 },
      { id: "hidden-chief", chiefOfStaff: true, hidden: true, createdAt: 5 },
    ];
    expect(mainDogId(chiefs, null, ["Sales", "Ops"])).toBe("sales-chief");
    expect(mainDogId(chiefs, null, ["Ops", "Sales"])).toBe("ops-chief");
    expect(mainDogId([...chiefs, { id: "general-chief", chiefOfStaff: true, createdAt: 60 }], null, ["Ops"])).toBe("general-chief");
    expect(mainDogId([{ id: "a", createdAt: 1 }, { id: "hidden-chief", chiefOfStaff: true, hidden: true }])).toBe("hidden-chief");
  });
});
