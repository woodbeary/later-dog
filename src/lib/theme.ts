import { SKIN_IDS, applySkin, type SkinId } from "./skins";

export type Theme = "system" | SkinId;

const KEY = "laterdog-skin";
const CHOICES: readonly Theme[] = ["system", "daylight", "midnight"];
let unfollow: (() => void) | undefined;

const isSkin = (value: unknown): value is SkinId => SKIN_IDS.some((id) => id === value);

function store(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function darkQuery(): MediaQueryList | undefined {
  try {
    return typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
  } catch {
    return undefined;
  }
}

export function readTheme(): Theme {
  try {
    const stored = store()?.getItem(KEY);
    return isSkin(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme): void {
  unfollow?.();
  unfollow = undefined;
  if (theme !== "system") return applySkin(theme);
  const query = darkQuery();
  const paint = () => {
    applySkin(query?.matches ? "midnight" : "daylight");
    try {
      store()?.setItem(KEY, "system");
    } catch {
      return;
    }
  };
  paint();
  query?.addEventListener?.("change", paint);
  unfollow = () => query?.removeEventListener?.("change", paint);
}

export function themeOptions(current: Theme): Theme[] {
  return CHOICES.includes(current) ? [...CHOICES] : [...CHOICES, current];
}
