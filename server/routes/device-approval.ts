import { isOpenDeviceApproval, type DeviceApprovalCardData, type DeviceApprovalEndedBy } from "../../shared/device-approval.ts";
import {
  deviceApprovalCard,
  deviceApprovalRequestedText,
  deviceApprovalSubtitle,
  deviceApprovalTitle,
  parseDeviceApprovalInput,
  type DeviceApprovalWait,
} from "../laterdog/device-approval.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const DEVICE_APPROVAL_PATH = "/api/internal/device-approval";

interface Room {
  id: string;
  name: string;
}

export interface DeviceApprovalRequestDeps {
  owner(botId: string, threadId: string): { group?: Room } | null;
  mayRunCheck(sender: BotRecord, threadId: string): boolean;
  cwd(sender: BotRecord, threadId: string): string | undefined;
  messages: Pick<Store, "activePath" | "patchMessage" | "appendMessage">;
  watch(wait: DeviceApprovalWait): void;
  unwatch(wait: Pick<DeviceApprovalWait, "threadId" | "messageId">): void;
  notify(sender: BotRecord, threadId: string, detail: string, room: Room | undefined): void;
  now(): number;
}

export const CHECK_NEEDS_UNATTENDED =
  "A check command runs on its own while you are waiting, so it needs this chat to run without asking first. Pass the login's pid instead, or leave both out and later.dog wakes you when the person taps Approved.";

export function openDeviceApproval(messages: readonly Message[], botId: string, group: boolean): Message | undefined {
  return messages.findLast((message) =>
    message.kind === "options" && message.card?.deviceApproval !== undefined && isOpenDeviceApproval(message.card.deviceApproval) &&
    (!group || message.from?.botId === botId));
}

export function createDeviceApprovalRequestRoute(deps: DeviceApprovalRequestDeps): InternalRouteHandler {
  return async ({ res, path, method, json, sender, threadId, readBody }) => {
    if (method !== "POST" || path !== DEVICE_APPROVAL_PATH) return PASS;
    const owner = deps.owner(sender.id, threadId);
    if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
    const body = await readBody();
    const input = parseDeviceApprovalInput(body ?? {}, deps.now());
    if (typeof input === "string") return json(res, 400, { error: input });
    if (input.check && !deps.mayRunCheck(sender, threadId)) return json(res, 403, { error: CHECK_NEEDS_UNATTENDED });
    const card = deviceApprovalCard(input);
    const shown = { title: deviceApprovalTitle(card), subtitle: deviceApprovalSubtitle(card), options: [], deviceApproval: card };
    const open = openDeviceApproval(deps.messages.activePath(threadId), sender.id, Boolean(owner.group));
    if (open?.card?.deviceApproval) {
      deps.unwatch({ threadId, messageId: open.id });
      deps.messages.patchMessage(threadId, open.id, { card: { ...open.card, deviceApproval: { ...open.card.deviceApproval, status: "ended", endedBy: "replaced" } } });
    }
    const messageId = deps.messages.appendMessage(threadId, {
      role: "bot",
      kind: "options",
      ...(owner.group ? { from: { botId: sender.id, name: sender.name, color: sender.color } } : {}),
      card: shown,
    }).id;
    deps.watch({
      botId: sender.id, threadId, messageId, expiresAt: card.expiresAt,
      ...(input.check ? { check: input.check, cwd: deps.cwd(sender, threadId) } : {}),
      ...(input.pid && !input.check ? { pid: input.pid } : {}),
    });
    deps.notify(sender, threadId, `${deviceApprovalTitle(card)}${card.code ? `: code ${card.code}` : ""}`, owner.group);
    return json(res, 201, { messageId, card, text: deviceApprovalRequestedText(card) });
  };
}

export interface DeviceApprovalCardRouteDeps {
  read(botId: string, threadId: string, messageId: string): DeviceApprovalCardData | null;
  end(botId: string, threadId: string, messageId: string, endedBy: DeviceApprovalEndedBy): DeviceApprovalCardData | null;
}

export function createDeviceApprovalCardRoutes(deps: DeviceApprovalCardRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/device-approvals\/([\w-]+)\/(done|dismiss)$/);
    if (!m || method !== "POST") return PASS;
    const body = await readBody(req);
    const threadId = String(body?.threadId ?? "");
    const card = deps.read(m[1]!, threadId, m[2]!);
    if (!card) return json(res, 404, { error: "no such device sign-in card" });
    if (!isOpenDeviceApproval(card)) return json(res, 200, { card });
    const ended = deps.end(m[1]!, threadId, m[2]!, m[3] === "done" ? "person" : "dismissed");
    return json(res, 200, { card: ended ?? deps.read(m[1]!, threadId, m[2]!) ?? card });
  };
}
