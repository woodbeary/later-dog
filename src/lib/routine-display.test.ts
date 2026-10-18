import { describe, expect, it } from "vitest";

import { routineRunMessageId, routineRunsOn } from "./routine-display";

describe("where a routine runs", () => {
  it("on My Cloud, every routine runs on schedule even when the person's computer is off", () => {
    expect(routineRunsOn({ roomGoal: false, cloudHome: true })).toEqual({
      label: "My Cloud", hint: "Runs on schedule, even when your computer is off.",
    });
    expect(routineRunsOn({ roomGoal: false, runOn: "cloud", cloudHome: true })).toEqual({
      label: "Cloud computer", hint: "Runs the whole job on the dog's cloud computer, even when your computer is off.",
    });
    expect(routineRunsOn({ roomGoal: false, computer: "cloud", cloudHome: true })).toEqual({
      label: "The dog's cloud computer", hint: "Runs on schedule, even when your computer is off.",
    });
    expect(routineRunsOn({ roomGoal: true, cloudHome: true })).toEqual({
      label: "My Cloud, with the whole group", hint: "Runs on schedule, even when your computer is off.",
    });
    expect(routineRunsOn({ roomGoal: false, computer: "vm", cloudHome: true }).label).toBe("My Cloud");
  });

  it("on a desktop, a routine starts while later.dog is open there", () => {
    expect(routineRunsOn({ roomGoal: false, cloudHome: false })).toEqual({
      label: "This computer", hint: "Starts while later.dog is open here.",
    });
    expect(routineRunsOn({ roomGoal: false, runOn: "cloud", cloudHome: false })).toEqual({
      label: "Cloud computer", hint: "Runs the whole job on the dog's cloud computer while later.dog is open.",
    });
    expect(routineRunsOn({ roomGoal: false, computer: "vm", cloudHome: false }).label).toBe("The dog's virtual machine");
    expect(routineRunsOn({ roomGoal: true, cloudHome: false }).label).toBe("This computer, with the whole group");
  });

  it("never names Boat or a cloud runner", () => {
    for (const cloudHome of [true, false]) {
      for (const input of [{ runOn: "cloud" }, { computer: "cloud" }, {}]) {
        const { label, hint } = routineRunsOn({ roomGoal: false, cloudHome, ...input });
        expect(`${label} ${hint}`).not.toMatch(/boat|runner|VM\b/i);
      }
    }
  });
});

describe("finding a run in the conversation", () => {
  it("picks the run's own row and nothing else", () => {
    const messages = [
      { id: "m1", kind: "text" },
      { id: "m2", kind: "routine.run", routineRun: { runId: "r-old" } },
      { id: "m3", kind: "routine.run", routineRun: { runId: "r-new" } },
    ];
    expect(routineRunMessageId("r-new", messages)).toBe("m3");
    expect(routineRunMessageId("r-missing", messages)).toBeUndefined();
  });
});
