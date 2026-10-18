export const PERSON_DENIED =
  "The person denied this, so it did not happen. Do not try to do it another way, and do not reword or split it to get past their answer. Tell them in one line and wait; they can ask you again.";

export function engineAnswer(behavior: "allow" | "deny" | "answer", message?: string): string | undefined {
  return behavior === "deny" ? PERSON_DENIED : message;
}
