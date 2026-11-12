export type FileChange = "created" | "edited" | "deleted";

export interface TurnResultFile {
  path: string;
  change: FileChange;
}

export interface TurnResultLink {
  kind: "pull-request" | "page" | "file";
  label: string;
  url: string;
}

export interface TurnResults {
  files?: TurnResultFile[];
  moreFiles?: number;
  links?: TurnResultLink[];
  commands?: number;
}

export interface ToolTouch {
  files?: Array<{ path: string; change: FileChange | "written" }>;
  command?: true;
}
