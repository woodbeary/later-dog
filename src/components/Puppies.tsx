import { DogAvatar } from "./Avatar";
import type { Helper, HelperMember, HelperState } from "../../shared/helpers";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import type { DogColor, DogState } from "@/lib/mascot";
import { t } from "@/lib/i18n";

export const PUPPY_LIMIT = 5;
export const puppyState: Record<HelperState, DogState> = { running: "working", done: "happy", failed: "sad", stopped: "sleeping" };
export const helperStateText = (state: HelperState) => t(`chat.helpers.${state}`);

export function puppyRows(helpers: readonly Helper[]): Array<Pick<HelperMember, "id" | "label" | "state" | "phase">> {
  return helpers.flatMap<Pick<HelperMember, "id" | "label" | "state" | "phase">>(helper => helper.members?.length
    ? helper.members.map(member => ({ ...member, id: `${helper.id}:${member.id}` }))
    : [helper]);
}

export function Puppies({ helpers, color = "yellow", bodyId }: { helpers: readonly Helper[]; color?: DogColor; bodyId?: MascotBodyId | null }) {
  const rows = puppyRows(helpers);
  if (!rows.length) return null;
  const reduced = typeof window !== "undefined" && (document.documentElement.dataset.reducedMotion === "true" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  return <span className="flex items-center gap-0.5" aria-label={t("chat.helpers.count", { count: rows.length })}>
    {rows.slice(0, PUPPY_LIMIT).map(row => <span key={row.id} title={`${row.label}${row.phase ? ` · ${row.phase}` : ""} · ${helperStateText(row.state)}`} className={row.state === "stopped" ? "opacity-50" : ""}>
      <DogAvatar color={color} bodyId={bodyId ?? undefined} size={23} state={puppyState[row.state]} label={`${row.label} · ${helperStateText(row.state)}`} trackPointer={false} animated={!reduced} />
    </span>)}
    {rows.length > PUPPY_LIMIT && <span className="pl-1 text-[11px] tabular-nums text-ink-tertiary">+{rows.length - PUPPY_LIMIT}</span>}
  </span>;
}
