export interface PendingAuthorization {
  url: string;
  createdAt: number;
}

export function reusableConnectionUrl(page: PendingAuthorization | null | undefined, now = Date.now()): string | null {
  return page && now >= page.createdAt && now - page.createdAt < 10 * 60 * 1_000 ? page.url : null;
}

export function reserveConnectionPage() {
  const openExternal = window.laterdog?.openExternal;
  let page: Window | null = null;
  let navigated = false;
  let cancelled = false;
  if (!openExternal) {
    try {
      page = window.open("", "_blank");
      if (page) page.opener = null;
    } catch {
      page?.close();
      page = null;
    }
  }
  return {
    async open(url: string): Promise<boolean> {
      if (cancelled) return false;
      if (openExternal) {
        await openExternal(url);
        return !cancelled;
      }
      if (!page || page.closed) return false;
      try {
        page.location.replace(url);
        navigated = true;
        return true;
      } catch {
        return false;
      }
    },
    cancel() {
      cancelled = true;
      if (!navigated && page && !page.closed) page.close();
    },
  };
}
