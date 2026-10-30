import { descendsFrom } from "@/lib/leaf-follow";
import type { Action, Message } from "./store";

export interface TaskView {
  botId: string;
  threadId: string;
  messages: Message[];
  hasMore: boolean;
  activeLeafId: string | null;
  loading: boolean;
  failed: boolean;
}

export type TaskViewAction =
  | { type: "openTask"; botId: string; threadId: string }
  | { type: "taskLoaded"; threadId: string; messages: Message[]; hasMore: boolean; activeLeafId: string | null }
  | { type: "taskLoadFailed"; threadId: string }
  | { type: "closeTask" }
  | { type: "markTaskDone"; botId: string; threadId: string; done: boolean };

export interface TaskViewState {
  taskView: TaskView | null;
}

const OPTIMISTIC_PREFIX = "optimistic-";

export function openedTaskView(botId: string, threadId: string): TaskView {
  return { botId, threadId, messages: [], hasMore: false, activeLeafId: null, loading: true, failed: false };
}

export function reduceTaskView<S extends TaskViewState>(state: S, action: TaskViewAction): S {
  switch (action.type) {
    case "openTask":
      return { ...state, taskView: openedTaskView(action.botId, action.threadId) };
    case "taskLoaded":
      return state.taskView?.threadId === action.threadId
        ? { ...state, taskView: { ...state.taskView, messages: action.messages, hasMore: action.hasMore, activeLeafId: action.activeLeafId, loading: false, failed: false } }
        : state;
    case "taskLoadFailed":
      return state.taskView?.threadId === action.threadId ? { ...state, taskView: { ...state.taskView, loading: false, failed: true } } : state;
    case "closeTask":
      return state.taskView ? { ...state, taskView: null } : state;
    case "markTaskDone":
      return state;
  }
}

export function withTaskMessage(view: TaskView, message: Message): TaskView {
  if (view.messages.some((held) => held.id === message.id)) return view;
  const optimisticId = message.sendId ? `${OPTIMISTIC_PREFIX}${message.sendId}` : null;
  const optimisticIndex = optimisticId ? view.messages.findIndex((held) => held.id === optimisticId) : -1;
  if (optimisticIndex >= 0) {
    return {
      ...view,
      messages: view.messages.map((held, index) => (index === optimisticIndex ? message : held)),
      activeLeafId: view.activeLeafId === optimisticId ? message.id : view.activeLeafId,
    };
  }
  const parent = message.parentId ?? null;
  const leaf = view.activeLeafId;
  const adoptsLeaf = parent === leaf || (leaf !== null && descendsFrom(view.messages, parent, leaf));
  return { ...view, messages: [...view.messages, message], activeLeafId: adoptsLeaf ? message.id : view.activeLeafId };
}

export function withPatchedTaskMessage(view: TaskView, message: Message): TaskView {
  return view.messages.some((held) => held.id === message.id)
    ? { ...view, messages: view.messages.map((held) => (held.id === message.id ? message : held)) }
    : view;
}

export function withOlderTaskMessages(view: TaskView, messages: readonly Message[], hasMore: boolean): TaskView {
  const held = new Set(view.messages.map((message) => message.id));
  return { ...view, messages: [...messages.filter((message) => !held.has(message.id)), ...view.messages], hasMore };
}

type FollowedAction = Extract<Action, { type: "messageAdded" | "messagePatched" | "threadActive" | "olderMessages" | "select" | "showRoutines" }>;

const FOLLOWED: ReadonlySet<Action["type"]> = new Set(["messageAdded", "messagePatched", "threadActive", "olderMessages", "select", "showRoutines"]);

export function followsTaskView(action: Action): action is FollowedAction {
  return FOLLOWED.has(action.type);
}

export function followTaskView<S extends TaskViewState>(state: S, action: FollowedAction): S {
  if (action.type === "select" || action.type === "showRoutines") {
    return state.taskView ? { ...state, taskView: null } : state;
  }
  const view = state.taskView;
  if (!view || action.threadId !== view.threadId) return state;
  switch (action.type) {
    case "messageAdded":
      return { ...state, taskView: withTaskMessage(view, action.message) };
    case "messagePatched":
      return { ...state, taskView: withPatchedTaskMessage(view, action.message) };
    case "threadActive":
      return { ...state, taskView: { ...view, activeLeafId: action.activeLeafId ?? null } };
    case "olderMessages":
      return { ...state, taskView: withOlderTaskMessages(view, action.messages, action.hasMore) };
  }
}
