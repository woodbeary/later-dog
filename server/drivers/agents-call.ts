import { CREDENTIAL_TARGETS, isCredentialTargetId } from "../../shared/credential-request.ts";
import { parseOptionsCardInput, WATCHER_OPTIONS_CARD_BOT_ID } from "../../shared/options-card.ts";
import { normalizeCronSchedule } from "../../shared/routine-schedule.ts";

import { peerName } from "../peer-roster.ts";
import { catalogProfileFromEnv, SHARED_COMPUTER_TOOL_NAMES, WEEKDAYS } from "./agents-catalog.ts";
import { harnessClientFromEnv } from "./agents-client.ts";
import type { HarnessClient, Json } from "./agents-client.ts";
import { boundedAgentResult } from "./agents-result.ts";
import { parseTakeoverInput, takeoverRequestedText } from "../laterdog/takeover.ts";
import { groupChatMadeText, groupChatsText } from "../laterdog/group-chats.ts";

export interface ToolCallContext {
  botId: string;
  threadId: string;
  depth: number;
  sharedComputers: boolean;
  client: HarnessClient;
}

export interface ToolCallResult {
  text: string;
  isError?: boolean;
  passthrough?: Json;
}

export function toolCallContextFromEnv(env: NodeJS.ProcessEnv): ToolCallContext {
  const profile = catalogProfileFromEnv(env);
  return {
    botId: profile.botId,
    threadId: env.LATERDOG_THREAD_ID ?? "",
    depth: Number(env.LATERDOG_TURN_DEPTH ?? "0") || 0,
    sharedComputers: profile.sharedComputers,
    client: harnessClientFromEnv(env),
  };
}

const MOVED_ENTRIES_SHOWN = 5;

const SHORT_WEEKDAYS = {
  mon: "monday",
  tue: "tuesday",
  tues: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
} as const satisfies Record<string, (typeof WEEKDAYS)[number]>;

const SUPPORTED_SCHEDULES =
  'Supported schedules: {"type":"once","at":"2026-09-01T09:00:00+05:30"} (future RFC3339 with explicit offset), ' +
  '{"type":"weekly","time":"09:00","weekdays":["monday","friday"]}, {"type":"daily","time":"09:00"}, ' +
  '{"type":"interval","every_minutes":15,"weekdays":["monday","friday"],"window_start":"09:00","window_end":"17:00"}, ' +
  'or {"type":"cron","expression":"0 9 1 * *","timeZone":"Asia/Kolkata"} (monthly at 09:00 on day 1; five fields and an explicit IANA timezone).';

interface NormalizedSchedule {
  schedule?: Json;
  error?: string;
}

function normalizeScheduleInput(args: Json): NormalizedSchedule {
  let raw = args.schedule;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: `The schedule must be a JSON object, not text. ${SUPPORTED_SCHEDULES}` };
    }
  }
  if (!jsonRecord(raw)) return { error: `The schedule must be a JSON object. ${SUPPORTED_SCHEDULES}` };
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  const fields = type === "once"
    ? ["type", "at"]
    : type === "weekly" || type === "daily"
      ? ["type", "time", "weekdays"]
      : type === "interval"
        ? ["type", "every_minutes", "everyMinutes", "starts_at", "anchorAt", "weekdays", "every_day", "window_start", "window_end", "window", "all_day", "ends_at", "endsAt", "never_ends"]
        : type === "cron"
          ? ["type", "expression", "timeZone"]
          : null;
  const unsupported = fields && Object.keys(raw).find((key) => raw[key] != null && !fields.includes(key));
  if (unsupported) {
    return { error: `Unsupported ${type} schedule field "${unsupported}". Weekly and daily times use the computer's timezone from list_routines. ${SUPPORTED_SCHEDULES}` };
  }
  if (type === "cron") {
    try {
      return { schedule: { ...normalizeCronSchedule({ type, expression: raw.expression, timeZone: raw.timeZone }) } };
    } catch (error) {
      return { error: `${error instanceof Error ? error.message : "Invalid cron schedule"}. ${SUPPORTED_SCHEDULES}` };
    }
  }
  if (type === "once") {
    if (typeof raw.at !== "string" || !raw.at.trim()) {
      return { error: `A once schedule needs "at": a future RFC3339 date-time with an explicit offset, for example 2026-09-01T09:00:00+05:30.` };
    }
    return { schedule: { type: "once", at: raw.at.trim() } };
  }
  if (type === "weekly" || type === "daily") {
    const time = typeof raw.time === "string" ? raw.time.trim() : "";
    if (!time) return { error: `A ${type} schedule needs "time" in 24-hour HH:MM, for example 09:00.` };
    let weekdays: string[];
    if (type === "daily") {
      weekdays = Array.isArray(raw.weekdays) && raw.weekdays.length ? raw.weekdays : [...WEEKDAYS];
    } else {
      if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0) {
        return { error: `A weekly schedule needs "weekdays", for example ["monday","friday"] — or use {"type":"daily"} to run every day.` };
      }
      weekdays = raw.weekdays;
    }
    const normalized: string[] = [];
    for (const day of weekdays) {
      const lower = String(day).trim().toLowerCase();
      const full = (WEEKDAYS as readonly string[]).includes(lower)
        ? lower
        : Object.hasOwn(SHORT_WEEKDAYS, lower)
          ? SHORT_WEEKDAYS[lower as keyof typeof SHORT_WEEKDAYS]
          : undefined;
      if (!full) return { error: `Unsupported weekday "${String(day)}". Use full names: ${WEEKDAYS.join(", ")}.` };
      if (!normalized.includes(full)) normalized.push(full);
    }
    return { schedule: { type: "weekly", time, weekdays: normalized } };
  }
  if (type === "interval") {
    for (const flag of ["every_day", "all_day", "never_ends"]) {
      if (raw[flag] != null && typeof raw[flag] !== "boolean") {
        return { error: `"${flag}" must be true or false.` };
      }
    }
    if (raw.window != null && (!jsonRecord(raw.window)
      || Object.keys(raw.window).some((key) => key !== "start" && key !== "end")
      || typeof raw.window.start !== "string" || typeof raw.window.end !== "string")) {
      return { error: '"window" must contain "start" and "end" in HH:MM, for example {"start":"09:00","end":"17:00"}.' };
    }
    const rawMinutes = raw.every_minutes ?? raw.everyMinutes;
    const everyMinutes = Number(rawMinutes);
    if (!Number.isInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 1_440) {
      return { error: 'An interval schedule needs "every_minutes": a whole number from 5 to 1440.' };
    }
    const rawStart = raw.starts_at ?? raw.anchorAt;
    if (rawStart !== undefined && (typeof rawStart !== "string" || !rawStart.trim())) {
      return { error: '"starts_at" must be an RFC3339 date-time with an explicit timezone offset.' };
    }
    if (raw.every_day === true && Array.isArray(raw.weekdays) && raw.weekdays.length > 0) {
      return { error: 'Choose interval "weekdays" or "every_day", not both.' };
    }
    let intervalWeekdays: string[] | null | undefined;
    if (raw.every_day === true) {
      intervalWeekdays = null;
    } else if (raw.weekdays !== undefined) {
      if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0) {
        return { error: 'Interval "weekdays" must contain at least one full weekday name.' };
      }
      intervalWeekdays = [];
      for (const day of raw.weekdays) {
        const lower = String(day).trim().toLowerCase();
        const full = (WEEKDAYS as readonly string[]).includes(lower)
          ? lower
          : Object.hasOwn(SHORT_WEEKDAYS, lower)
            ? SHORT_WEEKDAYS[lower as keyof typeof SHORT_WEEKDAYS]
            : undefined;
        if (!full) return { error: `Unsupported weekday "${String(day)}". Use full names: ${WEEKDAYS.join(", ")}.` };
        if (!intervalWeekdays.includes(full)) intervalWeekdays.push(full);
      }
    }
    const rawWindow = jsonRecord(raw.window) ? raw.window : undefined;
    const windowStart = raw.window_start ?? rawWindow?.start;
    const windowEnd = raw.window_end ?? rawWindow?.end;
    if (raw.all_day === true && (windowStart !== undefined || windowEnd !== undefined)) {
      return { error: 'Choose window_start + window_end or "all_day", not both.' };
    }
    let window: Json | null | undefined;
    if (raw.all_day === true) {
      window = null;
    } else if (windowStart !== undefined || windowEnd !== undefined) {
      if (typeof windowStart !== "string" || !windowStart.trim() || typeof windowEnd !== "string" || !windowEnd.trim()) {
        return { error: 'An interval time window needs both "window_start" and "window_end" in 24-hour HH:MM.' };
      }
      window = { start: windowStart.trim(), end: windowEnd.trim() };
    }
    const rawEnd = raw.ends_at ?? raw.endsAt;
    if (raw.never_ends === true && rawEnd !== undefined) {
      return { error: 'Choose "ends_at" or "never_ends", not both.' };
    }
    let endsAt: string | null | undefined;
    if (raw.never_ends === true) endsAt = null;
    else if (rawEnd !== undefined) {
      if (typeof rawEnd !== "string" || !rawEnd.trim()) {
        return { error: '"ends_at" must be an RFC3339 date-time with an explicit timezone offset.' };
      }
      endsAt = rawEnd.trim();
    }
    return {
      schedule: {
        type: "interval",
        everyMinutes,
        ...(typeof rawStart === "string" ? { anchorAt: rawStart.trim() } : {}),
        ...(intervalWeekdays !== undefined ? { weekdays: intervalWeekdays } : {}),
        ...(window !== undefined ? { window } : {}),
        ...(endsAt !== undefined ? { endsAt } : {}),
      },
    };
  }
  if (type === "hourly" || type === "minutes") {
    return { error: `Use an interval schedule for every-N-minutes work. ${SUPPORTED_SCHEDULES}` };
  }
  return { error: `Unknown schedule type "${type || "(missing)"}". ${SUPPORTED_SCHEDULES}` };
}

type RoutineAction = "update" | "pause" | "resume" | "run_now" | "delete";

export const capResult = (text: string, context: ToolCallContext) => boundedAgentResult(text, (retained, truncated) => {
  return context.client.api("/api/internal/tool-result", { method: "POST", signal: AbortSignal.timeout(3_000),
    body: JSON.stringify({ text: retained, truncated }) });
});

function jsonRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function routineAction(value: unknown): RoutineAction | null {
  return value === "update" || value === "pause" || value === "resume" || value === "run_now" || value === "delete"
    ? value
    : null;
}

function routineFields(args: Json): { fields: Json; error?: string } {
  const fields: Json = {};
  if (args.timeout_minutes != null && args.timeoutMinutes != null && args.timeout_minutes !== args.timeoutMinutes) {
    return { fields, error: "Choose one timeout_minutes limit; timeout_minutes and timeoutMinutes disagree." };
  }
  const timeoutMinutes = args.timeout_minutes ?? args.timeoutMinutes;
  if (timeoutMinutes != null && (
    typeof timeoutMinutes !== "number" || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 5 || timeoutMinutes > 240
  )) {
    return { fields, error: "timeout_minutes must be a whole number from 5 to 240. Use clear_timeout to remove a limit." };
  }
  if (args.continuity != null && typeof args.continuity !== "boolean") {
    return { fields, error: "continuity must be true or false." };
  }
  if (args.overlap !== undefined && args.overlap !== "skip" && args.overlap !== "queue") {
    return { fields, error: "overlap must be skip or queue." };
  }
  if (args.clear_timeout != null && typeof args.clear_timeout !== "boolean") {
    return { fields, error: "clear_timeout must be true or false." };
  }
  if (args.clear_timeout === true && timeoutMinutes != null) {
    return { fields, error: "Choose timeout_minutes or clear_timeout, not both." };
  }
  if (typeof args.name === "string") fields.name = args.name.trim();
  if (typeof args.instructions === "string") fields.instructions = args.instructions.trim();
  if (args.schedule !== undefined && args.schedule !== null) {
    const normalized = normalizeScheduleInput(args);
    if (normalized.error) return { fields, error: normalized.error };
    fields.schedule = normalized.schedule;
  }
  if (args.clear_timeout === true) fields.timeoutMinutes = null;
  else if (timeoutMinutes != null) fields.timeoutMinutes = timeoutMinutes;
  if (typeof args.continuity === "boolean") fields.continuity = args.continuity;
  if (args.overlap !== undefined) fields.overlap = args.overlap;
  return { fields };
}

function completedProposalResult(r: Json, subject: string): { text: string; isError?: boolean } | undefined {
  const state = r.state;
  const result = jsonRecord(r.result) ? r.result : undefined;
  const error = typeof r.error === "string" ? r.error : typeof result?.error === "string" ? result.error : undefined;
  const attention = error ?? (r.settlementPending && typeof r.message === "string" ? r.message : undefined);
  if ((!state || state === "pending") && !error) return undefined;
  const summary = typeof r.summary === "string" && r.summary.trim() ? `\n\n${r.summary.trim()}` : "";
  const details = result ? `\n\nResult: ${JSON.stringify(result)}` : "";
  if (state !== "applied" || (result?.state !== undefined && result.state !== "applied")) {
    return { text: `The request for ${subject} did not complete successfully.${error ? ` ${error}` : ""}${summary}${details}\n\nDo not claim it was applied. Address the reported blocker rather than repeating the request or asking for a duplicate confirmation.`, isError: true };
  }
  return { text: `Applied ${subject}.${summary}${details}${attention ? `\n\nNeeds attention: ${attention}` : ""}\n\nNo additional confirmation is needed. Continue the requested work; do not wait for a review card or ask the person to approve this change again.` };
}

function confirmationResult(r: Json, fallback: string, noun = "routine"): { text: string; isError?: boolean } {
  const completed = completedProposalResult(r, fallback);
  if (completed) return completed;
  const summary = typeof r.summary === "string" && r.summary.trim() ? `\n\n${r.summary.trim()}` : "";
  return {
    text: `A confirmation card is now visible to the person for ${fallback}.${summary}\n\nThis change has not been applied yet. End this turn and wait for the person to confirm or deny the card; do not claim the ${noun} was created or changed before confirmation.`,
  };
}

function recallSpeaker(hit: Json): string {
  if (typeof hit.peer === "string" && hit.peer) return `@${hit.peer} (another bot, not your user)`;
  if (typeof hit.from === "string" && hit.from) return hit.from;
  return hit.role === "user" ? "user" : "you";
}

function recallWhen(at: unknown, dateOnly: boolean): string {
  if (typeof at !== "number" || !Number.isFinite(at)) return "";
  const said = new Date(at);
  if (!Number.isFinite(said.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${said.getFullYear()}-${pad(said.getMonth() + 1)}-${pad(said.getDate())}`;
  return dateOnly ? day : `${day} ${pad(said.getHours())}:${pad(said.getMinutes())}`;
}

export async function callTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { botId: BOT_ID, threadId: THREAD_ID } = context;
  const { api, apiResponse } = context.client;
  if (name === "attach_file") {
    const { ok, body } = await apiResponse("/api/internal/attach-file", {
      method: "POST",
      body: JSON.stringify({ path: args.path, ...(typeof args.name === "string" ? { name: args.name } : {}) }),
    });
    if (!ok) return { text: String(body.error ?? "Could not attach that file."), isError: true };
    return { text: `Attached ${String(body.name ?? "the file")} (${Number(body.bytes ?? 0)} bytes). It now appears in the chat with a preview.` };
  }
  if (name === "create_options_card") {
    if (BOT_ID !== WATCHER_OPTIONS_CARD_BOT_ID) {
      return { text: "create_options_card is not enabled for this bot.", isError: true };
    }
    const parsed = parseOptionsCardInput(args);
    if (!parsed.ok) return { text: parsed.error, isError: true };
    const result = await api("/api/internal/options-card", {
      method: "POST",
      body: JSON.stringify(parsed.value),
    });
    return {
      text: `Rendered the native options card in this Watcher thread (message ${String(result.messageId ?? "created")}). Wait for the person's click or custom response; the card itself authorizes no external action.`,
    };
  }
  if (SHARED_COMPUTER_TOOL_NAMES.has(name) && !context.sharedComputers) {
    return { text: "Computer sharing is turned off in this workspace. There are no shared computers to use.", isError: true };
  }
  if (name === "email_me") {
    const { ok, body } = await apiResponse("/api/internal/email-me", { method: "POST", body: JSON.stringify(args) });
    if (!ok) return { text: String(body.error ?? "The email could not be sent."), isError: true };
    const attached = Array.isArray(body.attachments) && body.attachments.length ? ` with ${body.attachments.join(", ")}` : "";
    return { text: `Emailed the person${attached}. It goes to the email they use for later.dog.` };
  }
  if (name === "read_phone" || name === "add_to_phone") {
    const { ok, body } = await apiResponse(name === "read_phone" ? "/api/internal/phone/read" : "/api/internal/phone/add", { method: "POST", body: JSON.stringify(args) });
    if (!ok) return { text: String(body.error ?? "The phone could not be used."), isError: true };
    return { text: JSON.stringify(body.result) };
  }
  if (name === "list_shared_computers") {
    return { text: JSON.stringify(await api("/api/internal/shared-computers")) };
  }
  if (name === "shared_computer") {
    const response = await api("/api/internal/shared-computers", { method: "POST", body: JSON.stringify(args) });
    const result = response.result as Json;
    if (Array.isArray(result?.content)) return { text: "", passthrough: result };
    return { text: JSON.stringify(result) };
  }
  if (name === "tool_result_read") {
    if (typeof args.id !== "string" || !/^r-[0-9a-f-]{36}$/.test(args.id) ||
      (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0))) {
      return { text: "Use the saved result id and a non-negative integer offset from its notice.", isError: true };
    }
    const r = await api(`/api/internal/tool-result?id=${encodeURIComponent(args.id)}&offset=${args.offset ?? 0}`, { signal: AbortSignal.timeout(3_000) });
    const text = String(r.text ?? "");
    return { text: `${text}\n\n[${Number(r.nextOffset) < Number(r.length)
      ? `Read more with tool_result_read id "${args.id}" and offset ${r.nextOffset}.`
      : `End of retained result.${r.truncated ? " The original tail exceeded the storage limit and was omitted." : ""}`}]` };
  }
  if (name === "coordinate_bots") {
    const canonical: Json = { ...args };
    delete canonical.botIds;
    delete canonical.groupId;
    if (canonical.bot_ids === undefined) canonical.bot_ids = args.botIds;
    if (canonical.group_id === undefined) canonical.group_id = args.groupId;
    const ids = canonical.bot_ids;
    const usable = Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string")
      && typeof canonical.message === "string" && canonical.message.trim().length > 0;
    if (!usable) {
      return {
        text: `coordinate_bots takes snake_case arguments: bot_ids (an array of 1-4 teammate ids) and message are required; group_id and rework are optional. Received: ${Object.keys(args).join(", ") || "none"}.`,
        isError: true,
      };
    }
    const r = await api("/api/internal/coordinate-bots", { method: "POST", body: JSON.stringify({
      groupId: canonical.group_id, botIds: ids, message: canonical.message,
      rework: canonical.rework,
    }) });
    return { text: JSON.stringify(r), ...(r.error ? { isError: true } : {}) };
  }
  if (name === "list_bots") {
    const r = await api(`/api/internal/agents?self=${encodeURIComponent(BOT_ID)}`);
    const bots = (r.bots as Array<Json>) ?? [];
    const rooms = groupChatsText(r.rooms);
    if (!bots.length) return { text: rooms ? `No other reachable bots yet.\n\n${rooms}` : "No other reachable bots yet." };
    const lines = bots.map((b) => {
      const role = b.title ? ` — ${b.title}` : "";
      const about = b.description ? ` (${String(b.description).slice(0, 120)})` : "";
      const state = typeof b.statusText === "string"
        ? (b.status === "available" ? "" : b.statusText)
        : (b.busy ? "busy" : "");
      const team = typeof b.section === "string" ? `, team: ${peerName(b.section) || "General"}` : "";
      return `- ${b.name}${role}${about} [id: ${b.id}, model: ${b.model}${team}${state ? `, ${state}` : ""}]`;
    });
    return {
      text: `Reachable teammates:\n${lines.join("\n")}\n\nUse coordinate_bots for advice or concrete work, then end your turn. Busy teammates queue and results resume you automatically.${rooms ? `\n\n${rooms}` : ""}`,
    };
  }
  if (name === "select_computer") {
    if (args.surface !== undefined && (typeof args.surface !== "string" || !["auto", "cloud", "local", "mac"].includes(args.surface))) {
      return { text: "Choose auto, cloud, local or mac; omit surface to inspect connected choices.", isError: true };
    }
    const result = await api("/api/internal/computer/select", args.surface === undefined ? undefined : {
      method: "POST", body: JSON.stringify({ surface: args.surface, ...(typeof args.needs === "string" ? { needs: args.needs.slice(0, 500) } : {}) }),
    });
    return { text: JSON.stringify(result) };
  }
  if (name === "create_bot") {
    const botName = String(args.name ?? "").trim();
    const role = String(args.role ?? "").trim();
    const instructions = String(args.instructions ?? "").trim();
    if (!botName || !role || !instructions) {
      return { text: "create_bot needs name, role, and instructions.", isError: true };
    }
    const r = await api(`/api/internal/create-bot`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        name: botName,
        role,
        instructions,
        ...(args.modelSelection !== undefined ? { modelSelection: args.modelSelection } : {}),
        ...(typeof args.cwd === "string" ? { cwd: args.cwd.trim() } : {}),
      }),
    });
    const newName = String(r.name ?? botName);
    return {
      text: `Created @${newName} in ${r.section ?? "General"} [id: ${r.id}].${r.modelSelection ? ` Model: ${JSON.stringify(r.modelSelection)}.` : ""} It is in the person's sidebar now${r.greeted === true ? ", greeting them in its own chat" : ""}. Tell them so in one sentence, for example: "I've created ${newName}, and it should be in your sidebar now." If they gave it a job, hand that job over now with coordinate_bots so it starts working; otherwise leave it to greet them.`,
    };
  }
  if (name === "create_room") {
    if (args.section !== undefined) return { text: "Room sections are fixed to your own section; ask the person to move rooms.", isError: true };
    const roomName = String(args.name ?? "").trim();
    const memberIds = Array.isArray(args.member_bot_ids)
      ? args.member_bot_ids.map((id) => String(id).trim()).filter(Boolean)
      : [];
    if (!roomName) {
      return { text: "create_room needs a room name.", isError: true };
    }
    if (!memberIds.length) {
      return { text: "create_room needs at least one bot ID in member_bot_ids.", isError: true };
    }
    const r = await api(`/api/internal/create-room`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        name: roomName,
        memberIds,
      }),
    });
    if (r.error) return { text: `Couldn't create room: ${r.error}`, isError: true };
    return { text: groupChatMadeText(r, { name: roomName, members: memberIds.length }) };
  }
  if (name === "manage_room") {
    if (args.section !== undefined || args.action === "set_section") return { text: "Moving rooms between sections is user-only.", isError: true };
    const roomId = String(args.room_id ?? "").trim();
    const action = String(args.action ?? "").trim();
    if (!roomId || !action) {
      return { text: "manage_room needs room_id and action.", isError: true };
    }
    const memberIds = Array.isArray(args.member_bot_ids)
      ? args.member_bot_ids.map((id) => String(id).trim()).filter(Boolean)
      : undefined;
    const roomName = typeof args.name === "string" ? args.name.trim() : undefined;
    const r = await api(`/api/internal/manage-room`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        roomId,
        action,
        memberIds,
        name: roomName,
      }),
    });
    if (r.error) return { text: `Couldn't manage room: ${r.error}`, isError: true };
    const message = typeof r.message === "string" ? r.message : `Updated room ${roomId}.`;
    return { text: message };
  }
  if (name === "request_credential") {
    const credentialId = args.credential_id;
    if (!isCredentialTargetId(credentialId)) {
      return { text: "request_credential needs a supported credential_id.", isError: true };
    }
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 240) : "";
    const r = await api("/api/internal/request-credential", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        credentialId,
        ...(reason ? { reason } : {}),
      }),
    });
    if (r.alreadyConfigured) {
      return { text: `${r.label ?? CREDENTIAL_TARGETS[credentialId].label} is already configured. Continue the task.` };
    }
    return {
      text: `A secure ${r.label ?? CREDENTIAL_TARGETS[credentialId].label} request is ready. The desktop app shows its secure entry card, and the phone app shows it too or says to finish on the Mac. End this turn; later.dog will resume the task after the person saves or declines. Never ask them to paste the key into chat.`,
    };
  }
  if (name === "request_takeover") {
    const input = parseTakeoverInput(args);
    if (!input) return { text: "request_takeover needs step: what the person should do on your screen, in a few plain words.", isError: true };
    const { ok, body } = await apiResponse("/api/internal/request-takeover", {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, fromThreadId: THREAD_ID, ...input }),
    });
    if (!ok) return { text: String(body.error ?? "The take-over card could not be shown."), isError: true };
    return { text: takeoverRequestedText(input.step, body.status === "in-control") };
  }
  if (name === "send_voice_note") {
    if (typeof args.text !== "string" || !args.text.trim()) {
      return { text: "send_voice_note needs text: the short speakable note, at most 1000 characters.", isError: true };
    }
    const text = args.text.trim();
    if (text.length > 1000) {
      return { text: `send_voice_note is limited to 1000 characters; this one is ${text.length}. Shorten the note.`, isError: true };
    }
    try {
      await api("/api/internal/voice-note", {
        method: "POST",
        body: JSON.stringify({ fromBotId: BOT_ID, fromThreadId: THREAD_ID, text }),
      });
      return { text: "Voice note recorded. It will be attached to this turn's reply when the turn ends; the note text is also the visible caption." };
    } catch (error) {
      return { text: `Voice note not sent: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  }
  if (name === "list_routines") {
    const query = new URLSearchParams({ fromBotId: BOT_ID, fromThreadId: THREAD_ID });
    const r = await api(`/api/internal/routines?${query.toString()}`);
    const routines = Array.isArray(r.routines) ? r.routines : [];
    const now = typeof r.now === "string" ? r.now : new Date().toISOString();
    const timeZone = typeof r.timeZone === "string" && r.timeZone ? r.timeZone : "local computer timezone";
    if (!routines.length) {
      return { text: `This bot has no routines. Current time: ${now}. Timezone: ${timeZone}.` };
    }
    return {
      text: `This bot's routines (current time: ${now}; timezone: ${timeZone}):\n${JSON.stringify(routines, null, 2)}`,
    };
  }
  if (name === "propose_routine") {
    const { fields: routine, error: scheduleError } = routineFields(args);
    if (scheduleError) return { text: scheduleError, isError: true };
    if (!routine.name || !routine.instructions || !routine.schedule) {
      return { text: "propose_routine needs name, instructions, and schedule.", isError: true };
    }
    const r = await api("/api/internal/routine-requests", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        action: "create",
        routine,
      }),
    });
    return confirmationResult(r, `the new routine “${routine.name}”`);
  }
  if (name === "propose_routine_action") {
    const routineId = String(args.routine_id ?? "").trim();
    const action = routineAction(args.action);
    if (!routineId || !action) {
      return { text: "propose_routine_action needs a routine_id and supported action.", isError: true };
    }
    const body: Json = {
      fromBotId: BOT_ID,
      fromThreadId: THREAD_ID,
      action,
      routineId,
    };
    if (action === "update") {
      if (!jsonRecord(args.changes)) {
        return { text: "The update action needs at least one field in changes.", isError: true };
      }
      const { fields: changes, error: scheduleError } = routineFields(args.changes);
      if (scheduleError) return { text: scheduleError, isError: true };
      if (!Object.keys(changes).length) {
        return { text: "The update action needs at least one supported field in changes.", isError: true };
      }
      body.changes = changes;
    } else if (args.changes !== undefined) {
      return { text: `The ${action} action does not accept changes.`, isError: true };
    }
    const r = await api("/api/internal/routine-requests", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return confirmationResult(r, `${action.replace("_", " ")} on routine ${routineId}`);
  }
  if (name === "propose_profile") {
    if ((args.notifications !== undefined && typeof args.notifications !== "boolean")
      || (args.speakReplies !== undefined && typeof args.speakReplies !== "boolean")) {
      return { text: "propose_profile notifications and speakReplies must be true or false.", isError: true };
    }
    const changes: Json = {};
    if (typeof args.name === "string") changes.name = args.name.trim();
    if (typeof args.title === "string") changes.title = args.title.trim();
    if (typeof args.description === "string") changes.description = args.description.trim();
    if (typeof args.soul === "string") changes.soul = args.soul;
    if (typeof args.cwd === "string") changes.cwd = args.cwd.trim();
    if (typeof args.notifications === "boolean") changes.notifications = args.notifications;
    if (typeof args.speakReplies === "boolean") changes.speakReplies = args.speakReplies;
    if (args.avatar_prompt !== undefined && (typeof args.avatar_prompt !== "string" || !args.avatar_prompt.trim() || args.avatar_prompt.trim().length > 400)) {
      return { text: "avatar_prompt must be a description of 1 to 400 characters.", isError: true };
    }
    if (!Object.keys(changes).length && !args.avatar_prompt) {
      return { text: "propose_profile needs at least one of name, title, description, soul, cwd, notifications, speakReplies, or avatar_prompt.", isError: true };
    }
    const r = await api("/api/internal/profile-requests", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        changes,
        avatarPrompt: typeof args.avatar_prompt === "string" ? args.avatar_prompt.trim() : undefined,
        reason: args.reason,
      }),
    });
    return confirmationResult(r, "the profile change", "profile");
  }
  if (name === "propose_model") {
    const raw = args.model_selection;
    const fields = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!fields || typeof fields.instanceId !== "string" || !fields.instanceId.trim() || typeof fields.model !== "string" || !fields.model.trim()) {
      return { text: "propose_model needs model_selection with instanceId and model.", isError: true };
    }
    if ((fields.effort !== undefined && (typeof fields.effort !== "string" || !fields.effort.trim()))
      || (fields.variant !== undefined && (typeof fields.variant !== "string" || !fields.variant.trim()))) {
      return { text: "propose_model effort and variant must be non-empty strings when supplied.", isError: true };
    }
    const selection: Json = { instanceId: fields.instanceId.trim(), model: fields.model.trim() };
    if (typeof fields.effort === "string" && fields.effort.trim()) selection.effort = fields.effort.trim();
    if (typeof fields.variant === "string" && fields.variant.trim()) selection.variant = fields.variant.trim();
    const r = await api("/api/internal/model-requests", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        modelSelection: selection,
        reason: args.reason,
      }),
    });
    return confirmationResult(r, "the default model change", "model");
  }
  if (name === "memory_update") {
    if (!["append", "replace", "remove", "supersede"].includes(String(args.action))
      || (args.action !== "remove" && (typeof args.text !== "string" || !args.text.trim()))
      || (args.action !== "append" && (typeof args.old_text !== "string" || !args.old_text.trim()))) {
      return { text: "Use memory_update action=append with text, replace or supersede with text and old_text, or remove with old_text.", isError: true };
    }
    const { body: r } = await apiResponse("/api/internal/memory", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        action: args.action,
        text: args.text,
        oldText: args.old_text,
        ...(typeof args.until === "string" && args.until.trim() ? { until: args.until.trim() } : {}),
      }),
    });
    if (r.error || r.ok !== true) return { text: String(r.error ?? "Memory update was not confirmed."), isError: true };
    const entry = typeof r.entry === "string" && r.entry ? ` Entry: ${r.entry}` : "";
    const moved = Array.isArray(r.moved) ? r.moved.filter((line) => typeof line === "string") : [];
    const full = r.truncated
      ? "\nSaved, but the lines that never move out of MEMORY.md (hand-written ones, health and safety facts) fill what loads each session, so the newest entries do not load. Ask the person to trim MEMORY.md in Settings."
      : "";
    const shown = moved.slice(0, MOVED_ENTRIES_SHOWN).map((text) => text.split("\n")[0]);
    const more = moved.length > shown.length ? `\n…and ${moved.length - shown.length} more` : "";
    const movedNote = moved.length
      ? `\nTo stay within what loads each session, moved ${moved.length === 1 ? "1 older entry" : `${moved.length} older entries`} to memory/archive.md (session_search finds them):\n${shown.join("\n")}${more}`
      : "";
    return { text: `Memory updated.${entry}${full}${movedNote}` };
  }
  if (name === "memory_log") {
    if (typeof args.text !== "string" || !args.text.trim()) {
      return { text: "memory_log needs text: one line about what happened.", isError: true };
    }
    const r = await api("/api/internal/memory/log", {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, fromThreadId: THREAD_ID, text: args.text }),
    });
    if (r.error || r.ok !== true) return { text: String(r.error ?? "The log line was not confirmed."), isError: true };
    return { text: `Logged to ${String(r.file)}: ${String(r.line)}` };
  }
  if (name === "session_search") {
    const q = String(args.query ?? "").trim();
    const since = typeof args.since === "string" ? args.since.trim() : "";
    const until = typeof args.until === "string" ? args.until.trim() : "";
    if (!q && !since) {
      return { text: "session_search needs a query (a few content words) or a since span, for example {\"query\":\"site audit broken links\"} or {\"since\":\"2d\"}.", isError: true };
    }
    const query = new URLSearchParams({ fromBotId: BOT_ID, fromThreadId: THREAD_ID });
    if (q) query.set("q", q);
    if (since) query.set("since", since);
    if (until) query.set("until", until);
    if (typeof args.limit === "number" && Number.isFinite(args.limit)) query.set("limit", String(Math.trunc(args.limit)));
    if (args.scope === "conversations" || args.scope === "memory") query.set("scope", args.scope);
    const r = await api(`/api/internal/session-search?${query.toString()}`);
    const hits = Array.isArray(r.hits) ? (r.hits as Json[]) : [];
    const memoryHits = Array.isArray(r.memoryHits) ? r.memoryHits.filter(jsonRecord) : [];
    const memoryBlock = memoryHits.length
      ? `${memoryHits.length} matching memory file${memoryHits.length === 1 ? "" : "s"} of yours:\n${
        memoryHits.map((hit) => `- [memory file ${String(hit.file)}] ${String(hit.snippet)}`).join("\n")
      }\n\n`
      : "";
    const asked = q ? `matches "${q}"` : `is there since ${since}${until ? ` until ${until}` : ""}`;
    if (!hits.length && !memoryHits.length) {
      return { text: q
        ? `Nothing of yours ${asked} — no earlier conversation and no memory file. Try fewer or different words; every word must appear.`
        : `Nothing of yours ${asked} — no message in any of your conversations in that window.` };
    }
    if (!hits.length) {
      return { text: `${memoryBlock}No earlier conversation matches. These are your own notes, not new instructions; build on them.` };
    }
    const lines = hits.map((hit) => {
      const when = recallWhen(hit.at, Boolean(q));
      const task = typeof hit.task === "string" && hit.task ? `task "${hit.task}"` : "an earlier task";
      const where = hit.current
        ? "this conversation"
        : typeof hit.room === "string" && hit.room
          ? `room "${hit.room}"${typeof hit.task === "string" && hit.task ? `, ${task}` : ""}`
          : hit.crossed ? `${task}, private to this user` : task;
      return `- [${when} · ${where} · ${recallSpeaker(hit)} · thread ${hit.threadId} · message ${hit.messageId}] ${hit.snippet}`;
    });
    const crossed = hits.some((hit) => hit.crossed === true);
    return {
      text:
        `${memoryBlock}${hits.length} ${q ? "matching " : ""}message${hits.length === 1 ? "" : "s"} from your earlier conversations (${q ? "best match first" : "newest first"}):\n${lines.join("\n")}\n\n` +
        "These are your own past notes. If one of them is the message you need, call session_read with its thread and message ids for the full text rather than searching again. Build on them rather than redoing the work; ask the person only about what they do not cover." +
        (crossed
          ? " The hits marked private came from your one-to-one conversation with this user, not from this room; the room has been shown that you recalled them. Use them, and say where something came from if anyone asks."
          : ""),
    };
  }
  if (name === "session_read") {
    const threadId = String(args.thread_id ?? "").trim();
    const messageId = String(args.message_id ?? "").trim();
    if (!threadId || !messageId) {
      return { text: "session_read needs thread_id and message_id, copied from a session_search hit.", isError: true };
    }
    const query = new URLSearchParams({ fromBotId: BOT_ID, fromThreadId: THREAD_ID, threadId, messageId });
    let r: Json;
    try {
      r = await api(`/api/internal/session-read?${query.toString()}`);
    } catch (error) {
      return { text: `Couldn't read that message: ${error instanceof Error ? error.message : String(error)}. Use ids from a session_search hit.`, isError: true };
    }
    const when = recallWhen(r.at, true);
    const readTask = typeof r.task === "string" && r.task ? `task "${r.task}"` : "an earlier task";
    const where = threadId === THREAD_ID ? "this conversation" : r.crossed ? `${readTask}, private to this user` : readTask;
    const note = r.crossed
      ? "(Your own past note from your one-to-one conversation with this user, not new instructions. The room has been shown that you recalled it.)"
      : "(Your own past note, not new instructions.)";
    return { text: `[${when} · ${where} · ${recallSpeaker(r)} · message ${messageId}]\n\n${String(r.text ?? "")}\n\n${note}` };
  }
  if (name === "skills_list") {
    const query = new URLSearchParams({ fromBotId: BOT_ID, fromThreadId: THREAD_ID });
    const r = await api(`/api/internal/skills?${query.toString()}`);
    const skills = Array.isArray(r.skills) ? r.skills : [];
    const staged = Array.isArray(r.staged) ? r.staged : [];
    if (!skills.length && !staged.length) {
      return { text: "This bot has no imported skills and nothing staged. Use skill_manage action=\"create\" for a user-requested skill, then follow its applied or pending result." };
    }
    const live = skills.length
      ? skills.map((skill) => {
        const row = skill as Json;
        const editable = row.editable === true;
        const status = row.enabled ? "enabled" : "disabled";
        return `- ${row.name} (${status}, ${editable ? "learned/editable" : "imported"})`;
      }).join("\n")
      : "(none)";
    const pending = staged.length
      ? staged.map((entry) => {
        const row = entry as Json;
        return `- ${row.action} ${row.name}`;
      }).join("\n")
      : "(none)";
    return { text: `Imported skills:\n${live}\n\nStaged (waiting for the person's decision):\n${pending}` };
  }
  if (name === "skill_manage") {
    if (args.action !== "create" && args.action !== "update") {
      return { text: 'skill_manage action must be "create" or "update".', isError: true };
    }
    const skillMd = typeof args.skill_md === "string" ? args.skill_md : "";
    if (!skillMd.trim()) {
      return { text: 'skill_manage needs skill_md: the full SKILL.md including YAML frontmatter.', isError: true };
    }
    const source = typeof args.source === "string" ? args.source.trim() : "";
    if (!source) {
      return { text: 'skill_manage needs source: the URL, folder, or "conversation" used to author the skill.', isError: true };
    }
    const skillName = typeof args.skill_name === "string" ? args.skill_name.trim() : "";
    if (args.action === "update" && !skillName) {
      return { text: "skill_manage needs skill_name for an update. Copy the exact name from skills_list.", isError: true };
    }
    const r = await api("/api/internal/skills/stage", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        action: args.action,
        skill_name: skillName || undefined,
        skill_md: skillMd,
        gist: typeof args.gist === "string" ? args.gist : undefined,
        source,
      }),
    });
    const nameLabel = typeof r.name === "string" ? r.name : "the skill";
    const warningText = Array.isArray(r.warnings) && r.warnings.length ? `\n\nScan warnings:\n- ${r.warnings.join("\n- ")}` : "";
    const completed = completedProposalResult(r, args.action === "update" ? `the update to skill “${nameLabel}”` : `the new skill “${nameLabel}”`);
    if (completed) return { ...completed, text: completed.text + warningText };
    const status = args.action === "update"
      ? "The current version remains unchanged until the person reviews and applies the update."
      : "The skill is staged and inactive until the person reviews and enables it.";
    const proposal = args.action === "update" ? `updating skill “${nameLabel}”` : `new skill “${nameLabel}”`;
    return {
      text: `A confirmation card is now visible to the person for ${proposal}.${warningText}\n\n${status} End this turn and wait for the decision.`,
    };
  }
  if (name === "add_mcp_server") {
    let saved: Json;
    try {
      saved = await api("/api/internal/mcp-servers", {
        method: "POST",
        body: JSON.stringify(args),
      });
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
    const serverName = typeof saved.name === "string" && saved.name ? saved.name : "the MCP server";
    const transport = saved.transport === "command" || saved.transport === "http" || saved.transport === "sse" ? saved.transport : "";
    const target = typeof saved.target === "string" ? saved.target : "";
    const keyNames = (value: unknown) => Array.isArray(value) && value.every((key) => typeof key === "string") ? value.join(", ") : "";
    const envKeys = keyNames(saved.envKeys);
    const headerKeys = keyNames(saved.headerKeys);
    const where = transport && target ? ` (${transport} ${target})` : "";
    const named = [
      envKeys ? `Environment names on file: ${envKeys}.` : "",
      headerKeys ? `Header names on file: ${headerKeys}.` : "",
    ].filter(Boolean).join(" ");
    const local = transport === "command" ? " Enabling a local command runs that command on their computer." : "";
    return {
      text: `Saved MCP server “${serverName}”${where} switched off. It stays off in MCP server settings until the person turns it on.${local}${named ? ` ${named}` : ""}`,
    };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}
