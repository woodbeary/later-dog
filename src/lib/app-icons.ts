import { APP_ICON_FILES } from "./app-icon-files";

export function appIconUrl(domain: string | null | undefined): string | undefined {
  const file = domain ? APP_ICON_FILES[domain] : undefined;
  return file ? `/app-icons/${file}` : undefined;
}
