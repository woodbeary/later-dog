import { describe, expect, it } from "vitest";
import { MAX_NEW_TASKS, startedFromTask, startedWords, startTasks, startTasksInput, type TaskStarter } from "./dog-tasks.ts";

const OLIVE = { id: "dog-olive", name: "Olive" };

function fakeStarter(options: { refuse?: string; fail?: string } = {}) {
  const opened: { title: string; openedBy: unknown; threadId: string }[] = [];
  const ran: { threadId: string; instruction: string }[] = [];
  const starter: TaskStarter = {
    open: (title, openedBy) => {
      if (title === options.refuse) return null;
      const threadId = `task-${opened.length + 1}`;
      opened.push({ title, openedBy, threadId });
      return threadId;
    },
    run: async (threadId, instruction) => {
      if (opened.find((task) => task.threadId === threadId)?.title === options.fail) throw new Error("this dog has reached its limit of 10 parallel threads — wait for one to finish");
      ran.push({ threadId, instruction });
    },
  };
  return { starter, opened, ran };
}

describe("a dog starting tasks of its own", () => {
  it("opens each piece of work as its own conversation, marked as started by the dog from this one, and starts it", async () => {
    const { starter, opened, ran } = fakeStarter();
    const input = startTasksInput.parse({ tasks: [{ title: "Book the flights", instruction: "Find flights to Tokyo for Nov 12-19." }, { title: "Find a hotel", instruction: "Find a hotel near Shibuya." }] });
    const result = await startTasks(starter, OLIVE, "main-thread", input, 1_000);
    expect(opened.map((task) => [task.title, task.openedBy])).toEqual([
      ["Book the flights", { botId: "dog-olive", name: "Olive", kind: "work", threadId: "main-thread", at: 1_000 }],
      ["Find a hotel", { botId: "dog-olive", name: "Olive", kind: "work", threadId: "main-thread", at: 1_000 }],
    ]);
    expect(ran).toEqual([{ threadId: "task-1", instruction: "Find flights to Tokyo for Nov 12-19." }, { threadId: "task-2", instruction: "Find a hotel near Shibuya." }]);
    expect(result).toEqual({ started: [{ threadId: "task-1", title: "Book the flights" }, { threadId: "task-2", title: "Find a hotel" }], failed: [] });
    expect(startedWords(result)).toBe("Started 2 tasks: “Book the flights”, “Find a hotel”. Each works in its own conversation of yours and shows in the person's Tasks list, where they follow it, answer it and mark it done. Its replies stay there, not here. Tell the person in a sentence what you started.");
  });

  it("says which tasks couldn't start and why, so the dog does that work itself", async () => {
    const { starter } = fakeStarter({ refuse: "Taxes", fail: "Hotel" });
    const result = await startTasks(starter, OLIVE, "main-thread", startTasksInput.parse({ tasks: [{ title: "Flights", instruction: "a" }, { title: "Hotel", instruction: "b" }, { title: "Taxes", instruction: "c" }] }));
    expect(result.started.map((task) => task.title)).toEqual(["Flights"]);
    expect(startedWords(result)).toContain("Started a task: “Flights”.");
    expect(startedWords(result)).toContain("Couldn't start “Hotel”, “Taxes”: this dog has reached its limit of 10 parallel threads — wait for one to finish; it couldn't be opened. Do that work here instead.");
  });

  it("takes one to five tasks, each with a short title and an instruction", () => {
    const task = { title: "Flights", instruction: "Find flights." };
    expect(startTasksInput.safeParse({ tasks: [] }).success).toBe(false);
    expect(startTasksInput.safeParse({ tasks: Array.from({ length: MAX_NEW_TASKS + 1 }, () => task) }).success).toBe(false);
    expect(startTasksInput.safeParse({ tasks: [{ ...task, title: "x".repeat(61) }] }).success).toBe(false);
    expect(startTasksInput.safeParse({ tasks: [{ ...task, instruction: "  " }] }).success).toBe(false);
    expect(startTasksInput.safeParse({ tasks: [task], extra: true }).success).toBe(false);
    expect(startTasksInput.parse({ tasks: [{ title: "  Flights ", instruction: " Find flights. " }] })).toEqual({ tasks: [task] });
  });

  it("knows a task the dog started itself, so a task doesn't start more tasks", () => {
    expect(startedFromTask({ botId: "dog-olive", name: "Olive", kind: "work", threadId: "main", at: 1 }, "dog-olive")).toBe(true);
    expect(startedFromTask({ botId: "dog-rex", name: "Rex", kind: "work", at: 1 }, "dog-olive")).toBe(false);
    expect(startedFromTask({ botId: "dog-olive", name: "Olive", kind: "pair", at: 1 }, "dog-olive")).toBe(false);
    expect(startedFromTask(undefined, "dog-olive")).toBe(false);
  });
});
