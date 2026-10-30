import { describe, expect, it } from "vitest";
import type { Bot, Task } from "@/state/store";
import { dogTasks, findTask, taskStatus, tasksWaitingOnYou } from "./tasks";

const NOW = Date.parse("2026-10-29T20:00:00Z");
const opened = { botId: "olive", name: "Olive", at: NOW - 60_000 };

function task(threadId: string, patch: Partial<Task> = {}): Task {
  return { threadId, title: threadId, createdAt: NOW - 3_600_000, openedBy: opened, ...patch };
}

function dog(id: string, name: string, tasks: Task[]): Bot {
  return { id, name, threadId: `${id}-main`, tasks: [{ threadId: `${id}-main`, title: "Main", createdAt: 0 }, ...tasks] } as Bot;
}

describe("the tasks a dog started", () => {
  it("reads each task's state from what it is doing now", () => {
    expect(taskStatus(task("a", { activity: "waiting-on-you", busy: true }))).toBe("needsYou");
    expect(taskStatus(task("a", { busy: true }))).toBe("working");
    expect(taskStatus(task("a", { activity: "working" }))).toBe("working");
    expect(taskStatus(task("a", { unread: true }))).toBe("review");
    expect(taskStatus(task("a"))).toBe("open");
    expect(taskStatus(task("a", { archivedAt: NOW, unread: true }))).toBe("done");
    expect(taskStatus(task("a", { closedBy: { botId: "olive", name: "Olive", at: NOW } }))).toBe("done");
  });

  it("lists only work the dog started, not its own conversation, and lets done tasks go after a week", () => {
    const olive = dog("olive", "Olive", [task("flights", { updatedAt: NOW - 1_000 }), task("old", { archivedAt: NOW - 8 * 24 * 3_600_000 }), task("recent", { archivedAt: NOW - 3_600_000 }), { threadId: "earlier", title: "Earlier chat", createdAt: 0 }]);
    expect(dogTasks(olive, NOW).map((row) => row.task.threadId)).toEqual(["flights", "recent"]);
  });

  it("puts what needs the person first, then working, ready for review, open and done, newest first within each", () => {
    const olive = dog("olive", "Olive", [
      task("hotel", { updatedAt: NOW - 5_000 }),
      task("visa", { activity: "waiting-on-you" }),
      task("flights", { busy: true }),
      task("trains", { updatedAt: NOW - 1_000 }),
      task("taxes", { unread: true }),
      task("filed", { archivedAt: NOW }),
    ]);
    const rows = dogTasks(olive, NOW);
    expect(rows.map((row) => [row.status, row.task.threadId])).toEqual([
      ["needsYou", "visa"],
      ["working", "flights"],
      ["review", "taxes"],
      ["open", "trains"],
      ["open", "hotel"],
      ["done", "filed"],
    ]);
    expect(tasksWaitingOnYou(rows)).toBe(2);
  });

  it("keeps each dog's tasks with that dog", () => {
    const olive = dog("olive", "Olive", [task("flights")]);
    const rex = dog("rex", "Rex", [task("taxes", { openedBy: { botId: "rex", name: "Rex", at: NOW } })]);
    expect(dogTasks(olive, NOW).map((row) => row.task.threadId)).toEqual(["flights"]);
    expect(dogTasks(rex, NOW).map((row) => row.task.threadId)).toEqual(["taxes"]);
    expect(dogTasks({ tasks: undefined }, NOW)).toEqual([]);
  });

  it("finds a task by its dog and conversation", () => {
    const olive = dog("olive", "Olive", [task("flights")]);
    expect(findTask([olive], "olive", "flights")?.task.title).toBe("flights");
    expect(findTask([olive], "olive", "missing")).toBeNull();
  });
});
