// Exact app-owned browser state that belongs in an encrypted full backup.
// Never include cookies, authentication tokens, connection caches or unknown keys.
export const WORKSPACE_BACKUP_CLIENT_KEYS = [
  "laterdog-drafts",
  "laterdog-draft-attachments",
  "laterdog-draft-send-ids",
  "laterdog-draft-channel-modes",
  "laterdog-skin",
  "laterdog-show-threads",
  "laterdog-show-run-card",
  "laterdog.sidebarDensity",
  "laterdog.sidebarCollapsedSections.v1",
  "laterdog.sidebarSectionOrder.v1",
  "laterdog-analytics-opt-out",
  "laterdog.remote-voice.v1",
] as const;

export type WorkspaceBackupClientState = Partial<Record<(typeof WORKSPACE_BACKUP_CLIENT_KEYS)[number], string>>;
