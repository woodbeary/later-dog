import { describe, expect, it } from "vitest";
import type { Bot, Task } from "@/state/store";
import { findTask, taskRows, taskSections, taskStatus, tasksWaitingOnYou } from "./tasks";

const NOW = Date.parse("2026-10-29T20:00:00Z");
const opened = { botId: "olive", name: "Olive", at: NOW - 60_000 };

function task(threadId: string, patch: Partial<Task> = {}): Task {
  return { threadId, title: threadId, createdAt: NOW - 3_600_000, openedBy: opened, ...patch };
}

function dog(id: string, name: string, tasks: Task[]): Bot {
  return { id, name, threadId: `${id}-main`, tasks: [{ threadId: `${id}-main`, title: "Main", createdAt: 0 }, ...tasks] } as Bot;
}

describe("the tasks a person follows across their dogs", () => {
  it("reads each task's state from what it is doing now", () => {
    expect(taskStatus(task("a", { activity: "waiting-on-you", busy: true }))).toBe("needsYou");
    expect(taskStatus(task("a", { busy: true }))).toBe("working");
    expect(taskStatus(task("a", { activity: "working" }))).toBe("working");
    expect(taskStatus(task("a", { unread: true }))).toBe("review");
    expect(taskStatus(task("a"))).toBe("open");
    expect(taskStatus(task("a", { archivedAt: NOW, unread: true }))).toBe("done");
    expect(taskStatus(task("a", { closedBy: { botId: "olive", name: "Olive", at: NOW } }))).toBe("done");
  });

  it("lists only work a dog started, not each dog's own conversation, and lets done tasks go after a week", () => {
    const olive = dog("olive", "Olive", [task("flights", { updatedAt: NOW - 1_000 }), task("old", { archivedAt: NOW - 8 * 24 * 3_600_000 }), task("recent", { archivedAt: NOW - 3_600_000 }), { threadId: "earlier", title: "Earlier chat", createdAt: 0 }]);
    expect(taskRows([olive], NOW).map((row) => row.task.threadId)).toEqual(["flights", "recent"]);
  });

  it("groups tasks by state, the ones that need you first, newest first within each", () => {
    const olive = dog("olive", "Olive", [task("hotel", { updatedAt: NOW - 5_000 }), task("visa", { activity: "waiting-on-you" }), task("flights", { busy: true }), task("trains", { updatedAt: NOW - 1_000 })]);
    const rex = dog("rex", "Rex", [task("taxes", { unread: true }), task("filed", { archivedAt: NOW })]);
    const rows = taskRows([olive, rex], NOW);
    expect(taskSections(rows, "status").map((section) => [section.status, section.rows.map((row) => row.task.threadId)])).toEqual([
      ["needsYou", ["visa"]],
      ["working", ["flights"]],
      ["review", ["taxes"]],
      ["open", ["trains", "hotel"]],
      ["done", ["filed"]],
    ]);
    expect(taskSections(rows, "dog").map((section) => [section.bot?.name, section.rows.map((row) => row.task.threadId)])).toEqual([
      ["Olive", ["visa", "flights", "trains", "hotel"]],
      ["Rex", ["taxes", "filed"]],
    ]);
    expect(tasksWaitingOnYou(rows)).toBe(2);
  });

  it("finds a task by its dog and conversation", () => {
    const olive = dog("olive", "Olive", [task("flights")]);
    expect(findTask([olive], "olive", "flights")?.task.title).toBe("flights");
    expect(findTask([olive], "olive", "missing")).toBeNull();
  });
});
