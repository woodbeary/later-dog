import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FIXTURE_ANSWERS } from "./fixture-site.ts";
import { headlessBrowser, noVisionTasks, type HeadlessBrowser } from "./no-vision.ts";

const browser = headlessBrowser.available();

describe.skipIf(!browser)("a dog that is given no image at all", () => {
  let chrome: HeadlessBrowser;
  beforeAll(async () => { chrome = await headlessBrowser.start(); }, 30_000);
  afterAll(async () => { await chrome?.stop(); });

  it("finishes the three fixture web tasks with the page tools and the right answers", async () => {
    const runs = await noVisionTasks(chrome);
    expect(runs.map((run) => [run.task, run.correct])).toEqual([["find", true], ["form", true], ["table", true]]);
    expect(runs.find((run) => run.task === "find")!.answer).toBe(`${FIXTURE_ANSWERS.find.price}; free over ${FIXTURE_ANSWERS.find.threshold}`);
    expect(runs.flatMap((run) => run.steps).filter((step) => step.refusedImage)).toEqual([]);
    expect(runs.flatMap((run) => run.steps).every((step) => step.tool.startsWith("page_"))).toBe(true);
  }, 120_000);
});
