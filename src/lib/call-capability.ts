import { t } from "./i18n";

export function callSpeechMissing(
  capabilities: DesktopCapabilities,
  speechServiceAvailable: boolean,
): string | null {
  if (!capabilities.dictation.available) {
    switch (capabilities.dictation.reasonCode) {
      case "remote-server":
        return t("call.unavailable.remote");
      case "desktop-app-required":
      case "unsupported-platform":
        return t("call.unavailable.needsMac");
      default:
        return t("call.unavailable.noSpeech");
    }
  }
  return speechServiceAvailable ? null : t("call.unavailable.speechService");
}
