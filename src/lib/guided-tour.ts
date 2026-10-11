import type { OnboardingStatus } from "@/lib/onboarding";

export type TourStepId =
  | "tour.composer"
  | "tour.model"
  | "tour.computer"
  | "tour.apps"
  | "tour.apps-panel"
  | "tour.done";

/** Something the tour does to the app when a step begins or ends. The
 * "open" effects press the real control when it is on screen, so the app
 * reacts exactly as it would to the user. */
export type TourEffect =
  | "openApps"
  | "closeApps"
  | "backToChat";

/** Effects the anchor's own click already performs; when the user presses
 * the control instead of Next, the tour must not do it a second time. */
export const ANCHOR_EFFECTS: ReadonlySet<TourEffect> = new Set<TourEffect>(["openApps"]);

export interface TourStep {
  id: TourStepId;
  /** `data-tour` id of the control this step points at; null centres the card. */
  anchor: string | null;
  skipIfMissing?: boolean;
  placement: "above" | "below" | "right";
  onEnter?: TourEffect;
  onExit?: TourEffect;
}

export const TOUR_STEPS: TourStep[] = [
  { id: "tour.composer", anchor: "composer", placement: "above" },
  { id: "tour.model", anchor: "model", placement: "below" },
  { id: "tour.computer", anchor: "computer", placement: "below" },
  { id: "tour.apps", anchor: "nav-apps", skipIfMissing: true, placement: "right", onExit: "openApps" },
  { id: "tour.apps-panel", anchor: "apps-panel", placement: "below", onEnter: "openApps", onExit: "closeApps" },
  // back where they started: the closing card sits on the chat itself
  { id: "tour.done", anchor: "composer", placement: "above" },
];

function stepDone(record: OnboardingStatus | undefined, id: TourStepId): boolean {
  return (record?.hintsSeen ?? []).includes(id);
}

/** The first step not yet done, or null when the tour is over. */
export function currentStep(record: OnboardingStatus | undefined): TourStep | null {
  return TOUR_STEPS.find((step) => !stepDone(record, step.id)) ?? null;
}

/** 1-based position among the steps the user actually sees. */
export function stepNumber(step: TourStep): { current: number; total: number } {
  const visible = TOUR_STEPS.filter((s) => s.id !== "tour.done");
  const index = visible.indexOf(step);
  return { current: index < 0 ? visible.length : index + 1, total: visible.length };
}

/** The hint list with every tour step added, for a skip. */
export function withTourFinished(record: OnboardingStatus | undefined): string[] {
  const have = new Set(record?.hintsSeen ?? []);
  for (const step of TOUR_STEPS) have.add(step.id);
  return [...have];
}
