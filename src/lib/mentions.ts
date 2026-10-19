import { DOG_COLORS, type DogColor } from "./mascot";
import { isMentionBoundary, isMentionNameContinuation } from "../../shared/mention-boundary";

export type MentionPeer = {
  id?: string; name: string; formerNames?: readonly string[]; hidden?: boolean; color?: DogColor; mascotBody?: string | null;
  self?: boolean;
};
export type MentionRange = {
  start: number; end: number; color?: string; botId?: string; display?: string; dog?: DogColor; body?: string;
};

type MentionCandidate = { name: string; peer: MentionPeer; former: boolean; ambiguous?: boolean };

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const byPrecedence = (a: MentionCandidate, b: MentionCandidate) =>
  b.name.length - a.name.length || Number(Boolean(b.peer.self)) - Number(Boolean(a.peer.self)) || Number(a.former) - Number(b.former);

function mentionCandidates(everyPeer: readonly MentionPeer[], historical: boolean): MentionCandidate[] {
  const own = everyPeer.filter((peer) => peer.self && peer.name.trim())
    .map((peer): MentionCandidate => ({ name: peer.name, peer, former: false }));
  return [...own, ...peerCandidates(everyPeer.filter((peer) => !peer.self), historical)].sort(byPrecedence);
}

function peerCandidates(peers: readonly MentionPeer[], historical: boolean): MentionCandidate[] {
  if (historical) {
    const all = peers.flatMap((peer) => [peer.name, ...(peer.formerNames ?? [])]
      .filter((name) => name.trim())
      .map((name): MentionCandidate => ({ name, peer, former: !sameName(name, peer.name) })));
    return all.map((candidate) => ({
      ...candidate,
      ambiguous: candidate.peer.hidden || all.some((other) => sameName(other.name, candidate.name)
        && other.peer !== candidate.peer && !(other.peer.id && other.peer.id === candidate.peer.id)),
    }));
  }
  const visible = peers.filter((p) => !p.hidden && p.name.trim());
  const current = visible.map((peer): MentionCandidate => ({ name: peer.name, peer, former: false }));
  const aliases = visible.flatMap((peer) => (peer.formerNames ?? [])
    .filter((name) => name.trim() && !visible.some((other) => sameName(other.name, name)))
    .map((name): MentionCandidate => ({ name, peer, former: true })));
  const unambiguous = aliases.filter((alias) =>
    aliases.every((other) => other === alias || other.peer === alias.peer || !sameName(other.name, alias.name)));
  return [...current, ...unambiguous];
}

export function mentionChoicesForQuery<T extends { name: string }>(pool: readonly T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (query.endsWith(" ") && pool.some((choice) => choice.name.toLowerCase() === normalized)) return [];
  return pool.filter((choice) => !normalized || choice.name.toLowerCase().includes(normalized));
}

export function mentionRanges(text: string, peers: readonly MentionPeer[], everyone = false, historical = false): MentionRange[] {
  const candidates = mentionCandidates(peers, historical);
  const ranges: MentionRange[] = [];
  let at = -1;
  while ((at = text.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue;
    const rest = text.slice(at + 1);
    const found = candidates.find(({ name }) => rest.slice(0, name.length).toLowerCase() === name.toLowerCase()
      && !isMentionNameContinuation(rest.slice(name.length)));
    const peer = found?.peer;
    const all = everyone && rest.slice(0, 8).toLowerCase() === "everyone"
      && !isMentionNameContinuation(rest.slice(8));
    const length = all ? 8 : found?.name.length;
    if (length === undefined) continue;
    if (!all && (found?.ambiguous || peer?.self)) { at += length; continue; }
    const color = !all && peer?.color && Object.hasOwn(DOG_COLORS, peer.color) ? DOG_COLORS[peer.color] : undefined;
    ranges.push({
      start: at, end: at + length + 1, ...(color ? { color } : {}),
      ...(!all && peer?.id ? { botId: peer.id } : {}),
      ...(color ? { dog: peer!.color } : {}),
      ...(color && peer?.mascotBody ? { body: peer.mascotBody } : {}),
      ...(!all && found?.former ? { display: `@${peer!.name}` } : {}),
    });
    at += length;
  }
  return ranges;
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName: string; hProperties: { className: string; style?: string; "data-mention-dog"?: string; "data-mention-body"?: string } };
};

export function remarkMentions({ peers, everyone = false }: { peers: readonly MentionPeer[]; everyone?: boolean }) {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || ["link", "linkReference", "code", "inlineCode"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const text = child.value;
        const ranges = mentionRanges(text, peers, everyone, true);
        if (!ranges.length) return [child];
        const result: MarkdownNode[] = [];
        let end = 0;
        for (const range of ranges) {
          if (range.start > end) result.push({ type: "text", value: text.slice(end, range.start) });
          result.push({ type: "mention", data: { hName: "span", hProperties: {
            className: "mention-highlight",
            ...(range.color ? { style: `--mention-color:${range.color}` } : {}),
            ...(range.dog ? { "data-mention-dog": range.dog } : {}),
            ...(range.body ? { "data-mention-body": range.body } : {}),
          } },
            children: [{ type: "text", value: range.display ?? text.slice(range.start, range.end) }] });
          end = range.end;
        }
        if (end < text.length) result.push({ type: "text", value: text.slice(end) });
        return result;
      });
    };
    visit(tree);
  };
}
