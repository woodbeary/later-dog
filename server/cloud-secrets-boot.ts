import { takeCloudSecrets } from "./cloud-secrets.ts";

export const BOOT_CLOUD_SECRETS: Readonly<Record<string, string>> = takeCloudSecrets();
