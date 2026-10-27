export type SavedKeyTarget = "xaiApiKey" | "ttsKey" | "openaiImageApiKey";
export interface SavedKeyCandidate {
  id: string;
  label: string;
  hint: string | null;
}
export declare const SAVED_KEY_NAMES: Record<SavedKeyTarget, {
  names: string[];
  services: string[];
  looksRight(value: string): boolean;
}>;
export declare const SHELL_FILES: string[];
export declare function keysInShellText(text: string, names: string[]): Map<string, string>;
export declare function createSavedKeys(options?: {
  home?: string;
  env?: Record<string, string | undefined>;
  read?: (file: string) => Promise<string>;
  security?: (args: string[]) => Promise<string | null>;
}): {
  find(target: string): Promise<SavedKeyCandidate[]>;
  read(target: string, id: string): Promise<string>;
};
