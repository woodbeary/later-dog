import { t } from "./i18n";

export function liveDisclosure({ cloudHome = false }: { cloudHome?: boolean } = {}): string {
  return t(cloudHome ? "call.live.disclosureCloud" : "call.live.disclosure");
}
