export type PeerAction = "ask_bot" | "delegate_bot";

export function peerAllowKey(action: PeerAction, targetId: string): string {
  return `${action}:${targetId}`;
}
