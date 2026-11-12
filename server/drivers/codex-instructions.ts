import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import { volatileContextNote } from "./prompt-split.ts";
import {
  deliveredSections, matchingSections, parseDeliveredSections, sameDelivered, sectionNoteBody, sectionUpdate,
  type DeliveredSections, type VolatileSection,
} from "../laterdog/volatile-sections.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface CodexInstructionReceipt {
  instructions: string;
  volatile?: string;
  sections?: DeliveredSections;
}

const isFingerprint = (value: string) => /^[0-9a-f]{64}$/.test(value);

function parseReceipt(raw: string | undefined): CodexInstructionReceipt | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (isFingerprint(trimmed)) return { instructions: trimmed };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { instructions?: unknown; volatile?: unknown; sections?: unknown };
      if (typeof record.instructions === "string" && isFingerprint(record.instructions)) {
        const sections = parseDeliveredSections(record.sections);
        return {
          instructions: record.instructions,
          ...(typeof record.volatile === "string" && isFingerprint(record.volatile) ? { volatile: record.volatile } : {}),
          ...(sections ? { sections } : {}),
        };
      }
    }
  } catch {}
  return null;
}

export function codexDeveloperInstructions(config: unknown, botInstructions: string): string {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Codex returned no effective configuration; cannot safely update bot instructions.");
  }
  const configured = (config as Record<string, unknown>).developer_instructions;
  if (configured != null && typeof configured !== "string") {
    throw new Error("Codex returned invalid developer instructions; cannot safely update bot instructions.");
  }
  return configured
    ? `${botInstructions || "No later.dog bot-specific instructions remain."}\n\n${configured}`
    : botInstructions;
}

export async function syncCodexInstructions(
  key: string,
  nativeThreadId: string,
  instructions: string,
  volatile: string,
  resumed: boolean,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  mentionTurn = false,
  volatileSections?: readonly VolatileSection[],
): Promise<{ deliverVolatile: boolean; hadVolatile: boolean; note: string; commitVolatile: (() => void) | null }> {
  const directory = join(DATA_DIR, "codex-instructions");
  const path = join(directory, `${digest(JSON.stringify([key, nativeThreadId]))}.sha256`);
  const fingerprint = digest(instructions);
  const volatileFingerprint = digest(volatile);
  let previous: CodexInstructionReceipt | null;
  try {
    previous = parseReceipt(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    previous = null;
  }
  if (resumed && previous?.instructions !== fingerprint) {
    try {
      await request("thread/inject_items", {
        threadId: nativeThreadId,
        items: [{
          type: "message",
          role: "developer",
          content: [{
            type: "input_text",
            text: "The following replaces the previous developer instruction block supplied by later.dog, including its native configured rules and bot-specific instructions. Other Codex instructions and permissions still apply.\n\n"
              + (instructions || "No later.dog bot-specific instructions remain."),
          }],
        }],
      });
    } catch (error) {
      if (error instanceof Error && /method not found|unknown method/i.test(error.message)) {
        throw new Error(`This Codex version cannot update bot instructions in a resumed session. Update Codex and retry: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }
  const hadVolatile = typeof previous?.volatile === "string" && previous.volatile !== digest("");
  const sections = matchingSections(volatile, volatileSections);
  const delivered = sections ? deliveredSections(sections) : null;
  let deliverVolatile = !resumed || previous?.volatile !== volatileFingerprint || mentionTurn;
  let note = deliverVolatile ? volatileContextNote(volatile, hadVolatile) : "";
  if (sections) {
    const known = !resumed ? null : previous?.sections ?? (previous?.volatile === volatileFingerprint ? delivered : null);
    note = sectionNoteBody(sectionUpdate(sections, known, mentionTurn), resumed && known === null && hadVolatile);
    deliverVolatile = note !== "";
  }
  if (!resumed || previous?.instructions !== fingerprint) {
    mkdirSync(directory, { recursive: true });
    writeFileAtomic(path, JSON.stringify({ instructions: fingerprint }), { mode: 0o600 });
  }
  const upToDate = previous?.instructions === fingerprint && previous?.volatile === volatileFingerprint &&
    (delivered ? sameDelivered(previous.sections, delivered) : previous.sections === undefined);
  const commitVolatile = upToDate
    ? null
    : () => {
        mkdirSync(directory, { recursive: true });
        writeFileAtomic(path, JSON.stringify({ instructions: fingerprint, volatile: volatileFingerprint, ...(delivered ? { sections: delivered } : {}) }), { mode: 0o600 });
      };
  return { deliverVolatile, hadVolatile, note, commitVolatile };
}
