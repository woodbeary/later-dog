export const ALWAYS_ASK_IDS = [
  "push-skips-checks",
  "cloud-credential",
  "delete-outside-workspace",
  "sends-for-you",
  "pays",
] as const;

export type AlwaysAskId = (typeof ALWAYS_ASK_IDS)[number];

export const ALWAYS_ASK_WORDS = {
  "push-skips-checks": "askFirst.always.pushSkipsChecks",
  "cloud-credential": "askFirst.always.cloudCredential",
  "delete-outside-workspace": "askFirst.always.deleteOutside",
  "sends-for-you": "askFirst.always.sends",
  "pays": "askFirst.always.pays",
} as const satisfies Record<AlwaysAskId, string>;
