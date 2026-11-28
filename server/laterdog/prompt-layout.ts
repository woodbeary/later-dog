export type LayoutPart = { id: string; label: string; text: string };

const GROUP_OF: Readonly<Record<string, string>> = {
  persona: "",
  soul: "",
  guide: "",
  voice: "replies",
  replies: "replies",
  "user-profile": "the_person",
  "ask-first": "the_person",
  "owner-grant": "the_person",
  files: "files",
  computer: "computer",
  plan: "computer",
  browser: "browser",
  "cloud-home": "my_cloud",
  composio: "connected_apps",
  mcp: "connected_apps",
  credential: "sign_ins",
  recall: "recall",
  "cross-recall": "recall",
  routine: "routines",
  "routine-execution": "routines",
  profile: "changing_yourself",
  learn: "changing_yourself",
  proposals: "changing_yourself",
  skills: "skills",
  "skill-instructions": "skills",
  coordination: "team",
  assignment: "team",
  mentions: "team",
  updates: "progress",
};

const GROUP_ORDER: readonly string[] = ["", "replies", "the_person", "files", "computer", "browser", "my_cloud", "connected_apps", "sign_ins", "recall", "routines", "changing_yourself", "skills", "tools_and_places", "team", "progress"];
const LEAD_ORDER: readonly string[] = ["persona", "soul", "guide"];
const CHAT_TAIL: readonly string[] = ["files", "plan", "coordination", "assignment", "routine-execution", "webhook"];

export function sectionGroup(id: string): string {
  return GROUP_OF[id] ?? "tools_and_places";
}

function rank(id: string): number {
  const tail = CHAT_TAIL.indexOf(id);
  if (tail >= 0) return LEAD_ORDER.length + GROUP_ORDER.length + tail;
  const lead = LEAD_ORDER.indexOf(id);
  if (lead >= 0) return lead;
  return LEAD_ORDER.length + GROUP_ORDER.indexOf(sectionGroup(id));
}

export function renderStable(sections: readonly LayoutPart[]): string {
  const ordered = sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => rank(a.section.id) - rank(b.section.id) || a.index - b.index)
    .map(({ section }) => section);
  const out: string[] = [];
  let open = "";
  let body: string[] = [];
  const close = () => {
    const lines = body.map((text) => text.trim()).filter(Boolean);
    if (open && lines.length) out.push(`\n\n<${open}>\n${lines.join("\n")}\n</${open}>`);
    body = [];
  };
  for (const section of ordered) {
    const group = sectionGroup(section.id);
    if (group !== open) {
      close();
      open = group;
    }
    if (group) body.push(section.text);
    else if (section.text.trim()) out.push(out.length ? `\n\n${section.text.trim()}` : section.text.trim());
  }
  close();
  return out.join("");
}

const PROPOSAL_PARTS = new Set(["routine", "profile", "learn"]);

export function withProposalResults<T extends LayoutPart>(parts: readonly T[], proposalResult: string): Array<T | LayoutPart> {
  const lastAt = parts.reduce((last, part, index) => (PROPOSAL_PARTS.has(part.id) && part.text.trim() ? index : last), -1);
  if (lastAt < 0) return [...parts];
  return [...parts.slice(0, lastAt + 1), { id: "proposals", label: "Applying changes", text: ` ${proposalResult.trim()}` }, ...parts.slice(lastAt + 1)];
}
