import { describe, expect, it } from "vitest";
import { currentDogName, freshenDogName } from "./dog-refs";

const scout = { id: "d1", name: "Scout", formerNames: ["Pixel", "New Bot"] };

describe("dog references follow the current name", () => {
  it("answers with the current name by id and falls back to the stored one", () => {
    expect(currentDogName([scout], "d1", "Pixel")).toBe("Scout");
    expect(currentDogName([scout], "gone", "Pixel")).toBe("Pixel");
    expect(currentDogName([scout], undefined, "Pixel")).toBe("Pixel");
  });

  it("rewrites the stored name and every former name inside a label", () => {
    expect(freshenDogName("Messaged @Pixel", scout, "Pixel")).toBe("Messaged @Scout");
    expect(freshenDogName("Sent to New Bot · Launch", scout)).toBe("Sent to Scout · Launch");
    expect(freshenDogName("Message from @pixel", scout)).toBe("Message from @Scout");
  });

  it("leaves longer words and unrelated text alone", () => {
    expect(freshenDogName("Pixelated art for Pixels", scout)).toBe("Pixelated art for Pixels");
    expect(freshenDogName("Messaged @Scout", scout, "Scout")).toBe("Messaged @Scout");
    expect(freshenDogName("Messaged @Pixel", undefined, "Pixel")).toBe("Messaged @Pixel");
  });

  it("treats the name literally, not as a pattern", () => {
    const odd = { id: "d2", name: "Ada", formerNames: ["A+B (2)"] };
    expect(freshenDogName("Messaged @A+B (2)", odd)).toBe("Messaged @Ada");
  });
});
