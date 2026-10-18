import type { SurfacePlan } from "../surface.ts";

export type HomeCloudReadiness = "ready" | "not-ready" | "model-cannot" | "tools-off";

export interface HomeCloudInput {
  cloudHome: boolean;
  forced: boolean;
  browserOn: boolean;
  readiness: () => HomeCloudReadiness;
}

const UNREACHED: Record<Exclude<HomeCloudReadiness, "ready">, string> = {
  "not-ready": " This dog's cloud computer isn't ready yet, so it is not connected this turn: no desktop, files or shell. Answer what you can without it. If the person asks for work on a screen, tell them plainly that the cloud computer isn't ready yet; never claim you used it.",
  "model-cannot": " The model this dog runs on can't use a computer, so its cloud computer is not connected this turn. If the person asks for work on a screen, tell them to pick a model that can use a computer; never claim you used it.",
  "tools-off": " Computer tools are off in this dog's Access settings, so its cloud computer is not connected this turn. If the person asks for work on a screen, tell them to turn computer tools on in Access; never claim you used it.",
};

export function homeCloudPlan(plan: SurfacePlan, input: HomeCloudInput): SurfacePlan {
  if (!input.cloudHome || input.forced || plan.computer !== "cloud") return plan;
  const readiness = input.readiness();
  if (readiness === "ready") return plan;
  return { computer: undefined, browser: input.browserOn, pinned: null, note: UNREACHED[readiness] };
}
