import { t } from "./i18n";

export interface FeatureFlagConfig {
  features?: { skillAuthoring?: boolean; showToolCalls?: boolean; browser?: boolean; sharedComputers?: boolean; claudeUserMcp?: boolean; llmThreadTitles?: boolean; skillsLibrary?: boolean; cloudDictation?: boolean; typingSuggestions?: boolean; smarterSuggestions?: boolean };
  browserEngine?: { kind: "engine" | "unavailable"; reason?: string; installable?: boolean; installing?: boolean; installError?: string };
}

export function browserUnavailableReason(config: FeatureFlagConfig | null | undefined): string {
  const engine = config?.browserEngine;
  if (engine?.kind === "unavailable" && engine.installable) return t("browser.notInstalled");
  if (engine?.kind === "unavailable" && engine.reason) return engine.reason;
  return t("browser.noEngine");
}

export function skillAuthoringEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillAuthoring !== false;
}

export function builtInBrowserEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.browser === true;
}

export function cloudDictationEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.cloudDictation !== false;
}

export function typingSuggestionsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.typingSuggestions === true;
}

export function smarterSuggestionsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.smarterSuggestions === true;
}

export function showToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.showToolCalls === true;
}

export function sharedComputersEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.sharedComputers === true;
}

export function claudeUserMcpEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.claudeUserMcp === true;
}

export function llmThreadTitlesEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.llmThreadTitles === true;
}

export function skillsLibraryEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillsLibrary === true;
}
