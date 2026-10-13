import { expect, it } from "vitest";
import { presenceElapsed, presenceWords } from "./activity-presence";
import { t } from "./i18n";

it("keeps quick thinking quiet, gives long work a steady phrase and adds minutes after one minute", () => {
  expect(presenceWords(t("chat.activity.thinking"), 14_999)).toBe("");
  expect(presenceWords(t("chat.activity.thinking"), 15_000)).toBe(t("chat.activity.deepWork"));
  expect(presenceWords("Reading the notes", 200)).toBe("Reading the notes");
  expect(presenceElapsed(59_999)).toBe("");
  expect(presenceElapsed(60_000)).toBe("1m");
  expect(presenceElapsed(3_660_000)).toBe("1h 1m");
});
