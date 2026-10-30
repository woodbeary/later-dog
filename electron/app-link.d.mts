export type AppLinkScheme = "laterdog" | "laterdog-dev";
export type AppLinkHost = "dog" | "chat" | "thread" | "settings";
export type AppLinkSettingsSection = "general" | "computer" | "vault" | "usage" | "dashboard" | "updates";

export type AppLink =
  | { kind: "dog"; id: string }
  | { kind: "settings"; section: AppLinkSettingsSection | null };

export type AppLinkRejection = "malformed" | "scheme" | "route" | "id";

export type AppLinkResult =
  | { ok: true; link: AppLink; canonical: string }
  | { ok: false; reason: AppLinkRejection };

export declare const APP_LINK_SCHEMES: readonly AppLinkScheme[];
export declare const APP_LINK_HOSTS: readonly AppLinkHost[];
export declare const APP_LINK_SETTINGS_SECTIONS: readonly AppLinkSettingsSection[];
export declare const APP_LINK_MAX_LENGTH: number;
export declare function buildAppLink(link: AppLink, scheme?: AppLinkScheme): string;
export declare function parseAppLink(raw: unknown): AppLinkResult;
export declare function appLinkLogLabel(raw: unknown): string;
