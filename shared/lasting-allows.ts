export const LASTING_WHYS = ["always-asks", "owner-only", "secret", "incomplete", "screen", "teammate", "state"] as const;

export type LastingWhy = (typeof LASTING_WHYS)[number];

export type LastingOffer = { offered: true; reach: string } | { offered: false; why: LastingWhy };

export const LASTING_WHY_WORDS = {
  "always-asks": "lasting.why.alwaysAsks",
  "owner-only": "lasting.why.ownerOnly",
  "secret": "lasting.why.secret",
  "incomplete": "lasting.why.incomplete",
  "screen": "lasting.why.screen",
  "teammate": "lasting.why.teammate",
  "state": "lasting.why.state",
} as const satisfies Record<LastingWhy, string>;

export const ALWAYS_ALLOWED_KINDS = ["search", "app", "outside-delete", "saved-login", "teammate", "command"] as const;

export type AlwaysAllowedKind = (typeof ALWAYS_ALLOWED_KINDS)[number];

export type AlwaysAllowedItem = {
  id: string;
  kind: AlwaysAllowedKind;
  subject?: string;
  grantedAt?: string;
  state: "active" | "no-longer-used";
};

export type AlwaysAllowedList = { paused: boolean; items: AlwaysAllowedItem[] };
