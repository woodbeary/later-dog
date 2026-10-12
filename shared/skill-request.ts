export type SkillRequestAction = "create" | "update";

export interface SkillRequestCardData {
  version: 1;
  requestId: string;
  botId: string;
  threadId: string;
  stagedId: string;
  action: SkillRequestAction;
  name: string;
  gist: string;
  source?: string;
  preview?: string;
  sha256?: string;
  warnings: string[];
  createdAt: number;
  previous?: { preview: string; source: string };
}

export function reviewedSkillSha256(request: SkillRequestCardData): string | undefined {
  if (!request.preview || !request.sha256 || !/^[a-f0-9]{64}$/i.test(request.sha256)) return undefined;
  return request.sha256;
}

export function skillRequestBehavior(answer: string): "allow" | "deny" {
  const normalized = answer.trim().toLowerCase();
  return ["enable", "update", "apply", "allow", "allow once", "confirm", "yes"].includes(normalized)
    ? "allow"
    : "deny";
}
