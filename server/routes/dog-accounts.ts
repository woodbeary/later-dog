import type { BatteryAccount } from "../laterdog/account-battery.ts";
import { accountLabel, accountNames, matchAccount, unusable } from "../laterdog/account-switch.ts";
import { accountUsage, dogAccountsText, type AccountUsageInput, type DogAccountInput } from "../laterdog/account-usage.ts";
import type { BotRecord } from "../store.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export const DOG_ACCOUNTS_PATH = "/api/internal/dog-accounts";

export interface DogAccountsRouteDeps {
  active(capability: unknown): boolean;
  ownerActing(capability: unknown, threadId: string): boolean;
  mainBotId(): string | null;
  dogs(): BotRecord[];
  accounts(): BatteryAccount[];
  usage(): AccountUsageInput[];
  refresh(): Promise<void>;
  runsOn(bot: BotRecord): string | undefined;
  busy(bot: BotRecord): boolean;
  assign(bot: BotRecord, account: BatteryAccount, by: { sender: BotRecord; threadId: string }): { ok: true } | { ok: false; error: string };
  timeZone(): string | undefined;
  now?: () => number;
}

export function matchDogs(asked: readonly string[], dogs: readonly BotRecord[]): { found: BotRecord[]; problems: string[] } {
  const found: BotRecord[] = [];
  const problems: string[] = [];
  for (const raw of asked) {
    const want = raw.trim().toLowerCase();
    if (!want) continue;
    const exact = dogs.filter((dog) => dog.id === raw.trim() || dog.name.trim().toLowerCase() === want);
    const loose = exact.length ? exact : dogs.filter((dog) => dog.name.trim().toLowerCase().startsWith(want));
    if (loose.length === 1) {
      if (!found.includes(loose[0]!)) found.push(loose[0]!);
    } else if (loose.length > 1) {
      problems.push(`"${raw}" fits more than one dog: ${loose.map((dog) => `${dog.name} [id: ${dog.id}]`).join(", ")}; use the id.`);
    } else problems.push(`No dog called "${raw}".`);
  }
  return { found, problems };
}

export function dogAccountRows(deps: Pick<DogAccountsRouteDeps, "dogs" | "mainBotId" | "runsOn" | "busy">): DogAccountInput[] {
  const main = deps.mainBotId();
  return deps.dogs().map((dog) => {
    const runsOn = deps.runsOn(dog);
    return {
      id: dog.id,
      name: dog.name,
      main: dog.id === main,
      pinned: dog.accountPinned === true,
      account: dog.modelSelection.instanceId,
      ...(runsOn ? { runsOn } : {}),
      busy: deps.busy(dog),
    };
  });
}

export function createDogAccountsRoute(deps: DogAccountsRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, readBody, capability, sender, threadId }) => {
    if (path !== DOG_ACCOUNTS_PATH || (method !== "GET" && method !== "POST")) return PASS;
    if (!deps.active(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    if (!deps.ownerActing(capability, threadId)) {
      return json(res, 403, { error: "Only the owner's own dogs, working for the owner in the owner's home, can see and assign every dog's account. Use account_usage and switch_account for your own chat." });
    }
    const now = () => deps.now?.() ?? Date.now();
    const view = (lead: string) => {
      const report = accountUsage(deps.usage(), undefined, now());
      const text = dogAccountsText(dogAccountRows(deps), report, now(), deps.timeZone());
      return lead ? `${lead}\n\n${text}` : text;
    };
    if (method === "GET") {
      try { await deps.refresh(); } catch {}
      return json(res, 200, { text: view("") });
    }
    const body = await readBody();
    const asked = typeof body?.account === "string" ? body.account.slice(0, 200) : "";
    const names = Array.isArray(body?.dogs) ? body.dogs.filter((name: unknown): name is string => typeof name === "string").slice(0, 100) : [];
    if (!asked || !names.length) return json(res, 400, { error: "dog_accounts needs dogs (names or ids) and account to assign; call it with neither to see every dog's account." });
    const accounts = deps.accounts();
    const listed = accounts.filter((account) => account.eligible);
    const account = matchAccount(asked, listed);
    if (Array.isArray(account)) {
      return json(res, 404, { error: account.length
        ? `"${asked}" fits more than one account: ${accountNames(account)}. Ask which one.`
        : `No account called "${asked}". The accounts here are ${accountNames(listed)}.` });
    }
    const why = unusable(account);
    if (why) return json(res, 409, { error: `${accountLabel(account)} is ${why}, so no dog was moved. The accounts here are ${accountNames(listed)}.` });
    const { found, problems } = matchDogs(names, deps.dogs());
    const moved: string[] = [];
    for (const dog of found) {
      const done = deps.assign(dog, account, { sender, threadId });
      if (done.ok) moved.push(dog.name);
      else problems.push(`${dog.name} stays where it is: ${done.error}`);
    }
    const lead = [moved.length ? `Put ${moved.join(", ")} on ${accountLabel(account)}, pinned.` : "", ...problems].filter(Boolean).join(" ");
    return json(res, moved.length ? 200 : 409, { moved, problems, text: view(lead) });
  };
}
