import { chmodSync, writeFileSync } from "node:fs";
import type { Notification } from "../../shared/notification.ts";
import type { KnownGitHub } from "./home-github.ts";

export const GITHUB_CONNECT_LINE = "Connect GitHub in Settings so I can push with your Mac closed.";
export const GITHUB_HELPER_LINE = `later.dog: GitHub is not connected on My Cloud, so git cannot sign in to GitHub here. If the person's Mac is online, push from it with shared_computer. If it is offline, stop retrying and tell them in one line: ${GITHUB_CONNECT_LINE}`;
export const HOME_SYSTEM_GITCONFIG = "/etc/gitconfig";

export function githubFallbackHelper(): string {
  return `!f() { test "$1" = get || exit 0; cat >/dev/null; printf '%s\\n' "${GITHUB_HELPER_LINE}" >&2; echo quit=1; }; f`;
}

const gitConfigValue = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;

export function homeSystemGitConfig(): string {
  return `[credential "https://github.com"]\n\thelper = ${gitConfigValue(githubFallbackHelper())}\n`;
}

export function writeHomeSystemGitConfig(file = HOME_SYSTEM_GITCONFIG): void {
  writeFileSync(file, homeSystemGitConfig(), { mode: 0o644 });
  chmodSync(file, 0o644);
}

export function homeGitEnvironment(): Record<string, string> {
  return { GIT_TERMINAL_PROMPT: "0" };
}

const NEVER_SIGN_IN = " Never run gh auth login yourself.";
const OPEN_PULL_REQUESTS = " Open pull requests as drafts unless they ask otherwise, and don't merge unless they ask.";

function whenNotConnected(sharedComputerTools: boolean): string {
  const tellThem = `don't retry: tell them in one line, "${GITHUB_CONNECT_LINE}", and keep your work committed in your working folder here.`;
  return sharedComputerTools
    ? ` To push or open a pull request, use their Mac instead, without asking: get the repository there and run git and gh with shared_computer. If shared_computer says the Mac is offline, ${tellThem}`
    : ` To push or open a pull request, ${tellThem}`;
}

export function homeGitHubPrompt(known: KnownGitHub, sharedComputerTools: boolean): string {
  if (known.state === "connected") {
    return ` GitHub is connected on My Cloud as @${known.login}. Clone their repositories into your working folder, make a branch, commit, push and open pull requests with git and gh right here: it works while their Mac is closed, and you don't need to ask first.${OPEN_PULL_REQUESTS}`;
  }
  if (known.state === "disconnected") {
    return ` GitHub isn't connected on My Cloud yet, so git and gh can't sign in to GitHub here; you can still clone public repositories.${NEVER_SIGN_IN}${whenNotConnected(sharedComputerTools)}`;
  }
  return ` Run gh auth status before you push. When GitHub is connected on My Cloud, clone, branch, commit, push and open pull requests with git and gh right here, without asking.${OPEN_PULL_REQUESTS} When it isn't, git and gh can't sign in to GitHub here.${NEVER_SIGN_IN}${whenNotConnected(sharedComputerTools)}`;
}

const CONNECT_ASK = /connect github in settings so i can push/i;

export function githubNeededNotification(notification: Notification | null, reply: string): Notification | null {
  if (!notification || !CONNECT_ASK.test(reply)) return notification;
  return { ...notification, title: `${notification.botName} needs GitHub`, body: GITHUB_CONNECT_LINE };
}
