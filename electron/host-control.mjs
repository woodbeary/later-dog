export const HOST_CONTROL_TIMEOUT_MS = 10_000;
export const HOST_HELD = "This computer is in use locally or held by a person. Wait, then observe it again before acting.";
export const HOST_CONTROL_SLOW = "later.dog on this Mac didn't answer in time. Try again in a moment.";

export function hostControlRefusal(status) {
  return status === 409 ? HOST_HELD : `later.dog on this Mac couldn't start computer control (status ${status}). Try again in a moment.`;
}
