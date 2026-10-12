import { describe, expect, it } from "vitest";
import { rememberedItems, withoutLine } from "./SimpleMemory";

const FILE = `# Memory

Durable notes this bot keeps between tasks. The first 200 lines
load at the start of every session.

## Sam
- Prefers **short** answers
- Works on [later.dog](https://later.dog) at night
* Uses \`pnpm\`, never npm
- [x] Ships on Fridays
`;

describe("memory as a person reads it", () => {
  it("lists only the remembered lines, as plain sentences", () => {
    expect(rememberedItems(FILE).map((item) => item.words)).toEqual([
      "Prefers short answers",
      "Works on later.dog at night",
      "Uses pnpm, never npm",
      "Ships on Fridays",
    ]);
  });

  it("forgets one line and keeps the rest of the file as it was", () => {
    const [, second] = rememberedItems(FILE);
    const after = withoutLine(FILE, second!.line);
    expect(after).not.toContain("later.dog");
    expect(after).toContain("# Memory");
    expect(after).toContain("- Prefers **short** answers");
    expect(rememberedItems(after)).toHaveLength(3);
  });

  it("leaves the file alone when the line is already gone", () => {
    expect(withoutLine(FILE, "- not there")).toBe(FILE);
  });
});
