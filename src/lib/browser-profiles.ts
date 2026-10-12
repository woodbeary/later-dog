import { t } from "./i18n";

interface BrowserProfileUser {
  name: string;
  browserProfile?: string | null;
  busy?: boolean;
}

interface BrowserProfileRecord {
  id: string;
  name: string;
  partitionId?: string;
}

export function browserProfilesForPatch(profiles: BrowserProfileRecord[]): Array<{ id: string; name: string }> {
  return profiles.map(({ id, name }) => ({ id, name }));
}

export function browserProfilesMutation(current: BrowserProfileRecord[], next: BrowserProfileRecord[]) {
  return {
    browserProfiles: browserProfilesForPatch(next),
    expectedBrowserProfiles: browserProfilesForPatch(current),
  };
}

export function newBrowserProfileId(): string {
  return `profile-${crypto.randomUUID().replaceAll("-", "")}`;
}

export function browserProfileDeletionBlockReason(
  bots: BrowserProfileUser[],
  profileId: string,
): string | null {
  const running = bots.filter((bot) => bot.browserProfile === profileId && bot.busy);
  if (!running.length) return null;
  const names = running.map((bot) => bot.name).join(", ");
  return running.length === 1
    ? t("settings.profiles.busyOne", { names })
    : t("settings.profiles.busyMany", { names });
}
