import { describe, expect, it } from "vitest";
import { currentDogName, freshenDogName } from "./dog-refs";

const scout = { id: "d1", name: "Scout", formerNames: ["Pixel", "New Bot"] };

describe("dog references follow the current name", () => {
  it("answers with the current name by id and falls back to the stored one", () => {
    expect(currentDogName([scout], "d1", "Pixel")).toBe("Scout");
    expect(currentDogName([scout], "gone", "Pixel")).toBe("Pixel");
    expect(currentDogName([scout], undefined, "Pixel")).toBe("Pixel");
  });

  it("rewrites a mention of the stored or an earlier name", () => {
    expect(freshenDogName("Messaged @Pixel", scout, "Pixel")).toBe("Messaged @Scout");
    expect(freshenDogName("Message from @pixel", scout)).toBe("Message from @Scout");
    expect(freshenDogName("Delegated to @New Bot: look at it", scout)).toBe("Delegated to @Scout: look at it");
  });

  it("rewrites the name in the chip labels the server writes", () => {
    expect(freshenDogName("Sent to New Bot · Launch", scout)).toBe("Sent to Scout · Launch");
    expect(freshenDogName("Sent to Pixel", scout)).toBe("Sent to Scout");
    expect(freshenDogName("Opened thread #Colour question on Pixel", scout)).toBe("Opened thread #Colour question on Scout");
    expect(freshenDogName("Added to thread #Sky on New Bot", scout)).toBe("Added to thread #Sky on Scout");
  });

  it("starts a result label with the dog only when the caller says that slot is the dog", () => {
    expect(freshenDogName("Pixel finished", scout)).toBe("Pixel finished");
    expect(freshenDogName("Pixel finished", scout, undefined, { leading: true })).toBe("Scout finished");
  });

  it("never touches ordinary words that happen to match a name", () => {
    expect(freshenDogName("The new bot pixel is on the page", scout)).toBe("The new bot pixel is on the page");
    expect(freshenDogName("Opened thread #Pixel art on the new bot", scout)).toBe("Opened thread #Pixel art on the new bot");
    expect(freshenDogName("Pixelated art for Pixels @Pixelated", scout)).toBe("Pixelated art for Pixels @Pixelated");
    expect(freshenDogName("email me@Pixel.test", scout)).toBe("email me@Pixel.test");
    expect(freshenDogName("Messaged @Scout", scout, "Scout")).toBe("Messaged @Scout");
    expect(freshenDogName("Messaged @Pixel", undefined, "Pixel")).toBe("Messaged @Pixel");
  });

  it("treats the name literally, not as a pattern", () => {
    const odd = { id: "d2", name: "Ada", formerNames: ["A+B (2)"] };
    expect(freshenDogName("Messaged @A+B (2)", odd)).toBe("Messaged @Ada");
  });
});
