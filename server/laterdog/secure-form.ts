import {
  asksForDetails,
  isOpenSecureForm,
  isSharedHost,
  normalizeSecureHost,
  SECURE_FIELD_DETAILS,
  SECURE_FIELD_ID,
  SECURE_FIELD_TYPES,
  SECURE_FORM_MAX_FIELDS,
  SECURE_VALUE_CHARS,
  type SecureFormCardData,
  type SecureFormField,
} from "../../shared/secure-form.ts";
import { fitsOnOneLine } from "../../shared/bot-profile.ts";
import { detailsFromForm, savesAsLogin, vaultAllowKey, vaultFieldPlan, vaultSite, type VaultDetails, type VaultFieldPlan, type VaultLogin } from "../../shared/vault.ts";

export const SECURE_FORM_TTL_MS = 10 * 60_000;
export const SECURE_FORM_AFTER_FILLED_MS = 2 * 60_000;
export const SECURE_FIELD_MAX_TYPINGS = 3;
export const SECURE_TOOLBAR_PX = 100;
const TITLE_CHARS = 80;
const LABEL_CHARS = 40;
const coordinate = { type: "integer", minimum: 0, maximum: 32767 };
const fieldId = { type: "string", pattern: SECURE_FIELD_ID.source };

export const SECURE_FORM_TOOLS = [
  {
    name: "request_secure_form",
    description:
      "Ask the person for details only they know (an email or username, a password, a one-time code) with a sealed Secure Form card, to sign in on this cloud computer. Open the sign-in page in the browser first; site is the host shown in its address bar, for example accounts.google.com. Name the step plainly, for example \"Sign in to iCloud\"; when asking again after a failed try, keep the same title and say in one short line what the site said. You never see the values. End your turn right after; later.dog wakes you when they press Continue, then type each value with fill_secure_field. When they keep a login for the site in their vault and let you use it without asking, the form comes back already filled: then type each value straight away. Ask the same way for their contact details on a checkout, booking or sign-up page: one field per box on the page, each with its autocomplete name (name, given-name, family-name, email, tel, organization, street-address, address-line1, address-line2, address-level2 for the city, address-level1 for the state or region, postal-code, country-name) so they can fill it from the details saved in their vault, and optional: true on boxes the page doesn't require.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: TITLE_CHARS },
        site: { type: "string", minLength: 3, maxLength: 253 },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: SECURE_FORM_MAX_FIELDS,
          items: {
            type: "object",
            properties: {
              id: fieldId,
              label: { type: "string", minLength: 1, maxLength: LABEL_CHARS },
              type: { type: "string", enum: [...SECURE_FIELD_TYPES] },
              autocomplete: { type: "string", enum: [...SECURE_FIELD_DETAILS] },
              optional: { type: "boolean" },
            },
            required: ["id", "label", "type"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "site", "fields"],
      additionalProperties: false,
    },
  },
  {
    name: "fill_secure_field",
    description:
      "Type one value from a filled Secure Form into the field at x, y of the browser page. later.dog checks the browser is on the form's site over HTTPS, clicks the field and types the value; you never see it. Set submit to press Enter afterwards, then take a screenshot to check the page.",
    inputSchema: {
      type: "object",
      properties: {
        form_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
        field_id: fieldId,
        x: coordinate,
        y: coordinate,
        submit: { type: "boolean" },
      },
      required: ["form_id", "field_id", "x", "y"],
      additionalProperties: false,
    },
  },
];

export const SECURE_FORM_PROMPT =
  " This cloud computer is yours for working on the web for them. Its browser stays signed in to the sites you sign in to, so you can read their inbox, check them in for a flight, book something or fill in a form, and come back later still signed in. When they ask you to sign in somewhere, do it straight away without asking why: open the site's sign-in page in the browser, then call request_secure_form for only what they know (an email or username, a password, a one-time code) and end the turn. They fill in a sealed card, or pick a login saved in their later.dog vault; later.dog wakes you, and fill_secure_field types each value straight into the page without you seeing it. A code that arrives later gets another Secure Form. For their name, email, phone or address on a checkout or booking page, ask with request_secure_form too, tagging each field with its autocomplete name, rather than asking in chat. Never say you can't sign in or can't handle passwords, never ask them to sign in themselves when a Secure Form can do it, and never ask for passwords or codes in chat. Keep request_takeover for what a form can't do: a CAPTCHA, a passkey or security key, an approval on their phone, or a payment.";

export interface SecureFormInput {
  title: string;
  host: string;
  fields: SecureFormField[];
}

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? [...value].map((char) => (fitsOnOneLine(char) ? char : " ")).join("").replace(/\s+/g, " ").trim().slice(0, max).trim() : "";

const RETRY_MARK = /\s*[([](?:re-?try(?:ing)?|again|try again|another try|new try|(?:second|third|2nd|3rd|next) (?:try|attempt)|attempt \d+|take \d+)[)\]]\s*$/i;

export function parseSecureFormInput(raw: Record<string, unknown>): SecureFormInput | { error: string } {
  const title = clean(raw.title, TITLE_CHARS).replace(RETRY_MARK, "").trim();
  if (!title) return { error: "request_secure_form needs a short title, for example \"Sign in to iCloud\"." };
  const host = normalizeSecureHost(raw.site);
  if (!host) return { error: "Name the site's own address as shown in the browser's address bar, for example icloud.com." };
  if (isSharedHost(host)) return { error: `${host} is shared by many sites. Name the full address shown in the browser's address bar.` };
  const list = Array.isArray(raw.fields) ? raw.fields : [];
  if (!list.length || list.length > SECURE_FORM_MAX_FIELDS) return { error: `Ask for 1 to ${SECURE_FORM_MAX_FIELDS} fields.` };
  const fields: SecureFormField[] = [];
  for (const entry of list) {
    const field = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const id = typeof field.id === "string" ? field.id : "";
    const label = clean(field.label, LABEL_CHARS);
    const type = SECURE_FIELD_TYPES.find((candidate) => candidate === field.type);
    if (!SECURE_FIELD_ID.test(id) || !label || !type) {
      return { error: "Each field needs an id (lowercase letters, digits and _), a label, and a type: text, email, password or code." };
    }
    if (fields.some((existing) => existing.id === id)) return { error: `Field ids must be unique; ${id} appears twice.` };
    const autocomplete = field.autocomplete === undefined ? undefined : SECURE_FIELD_DETAILS.find((candidate) => candidate === field.autocomplete);
    if (field.autocomplete !== undefined && (!autocomplete || (type !== "text" && type !== "email"))) {
      return { error: `autocomplete goes on text or email fields, and is one of ${SECURE_FIELD_DETAILS.join(", ")}.` };
    }
    if (field.optional === true && type !== "text" && type !== "email") return { error: "Only text and email fields can be optional." };
    fields.push({ id, label, type, ...(autocomplete ? { autocomplete } : {}), ...(field.optional === true ? { optional: true } : {}) });
  }
  return { title, host, fields };
}

export function parseSecureValues(fields: readonly SecureFormField[], raw: unknown): Map<string, string> | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Fill in every field." };
  const entries = raw as Record<string, unknown>;
  if (Object.keys(entries).some((key) => !fields.some((field) => field.id === key))) {
    return { error: "This form changed. Close it and open it again." };
  }
  const values = new Map<string, string>();
  for (const field of fields) {
    const value = Object.hasOwn(entries, field.id) ? entries[field.id] : undefined;
    if (typeof value !== "string") return { error: "Fill in every field." };
    const typed = field.type === "password" ? value : value.trim();
    if (!typed && field.optional) continue;
    if (!typed) return { error: "Fill in every field." };
    if (typed.length > SECURE_VALUE_CHARS) return { error: `${field.label} is too long.` };
    if (!fitsOnOneLine(typed)) return { error: `${field.label} has characters that cannot be typed.` };
    values.set(field.id, typed);
  }
  return values;
}

interface VaultEntry {
  values: Map<string, string>;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class SecureFormVault {
  private readonly entries = new Map<string, VaultEntry>();
  private readonly onExpire: (key: string) => void;

  constructor(onExpire: (key: string) => void) {
    this.onExpire = onExpire;
  }

  hold(key: string, values: Map<string, string>, ttlMs: number): void {
    this.forget(key);
    this.entries.set(key, { values, expiresAt: Date.now() + ttlMs, timer: this.timer(key, ttlMs) });
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  value(key: string, field: string): string | undefined {
    return this.entries.get(key)?.values.get(field);
  }

  shorten(key: string, ttlMs: number): void {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now() + ttlMs) return;
    clearTimeout(entry.timer);
    entry.expiresAt = Date.now() + ttlMs;
    entry.timer = this.timer(key, ttlMs);
  }

  forget(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.values.clear();
    this.entries.delete(key);
  }

  private timer(key: string, ttlMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.forget(key);
      this.onExpire(key);
    }, ttlMs);
    timer.unref?.();
    return timer;
  }
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export function secureFillCommand(input: { host: string; x: number; y: number; value: string; submit: boolean }): string {
  const { host, x, y } = input;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !/^[a-z0-9.-]+$/.test(host)) throw new RangeError("invalid secure fill target");
  const encoded = Buffer.from(input.value, "utf8").toString("base64");
  return [
    "w=$(xdotool getactivewindow 2>/dev/null) || exit 3",
    "c=$(xprop -id \"$w\" WM_CLASS 2>/dev/null | head -n 1)",
    "printf '%s\\n' \"$c\" | grep -qiE '\"(chromium|chromium-browser|google-chrome|chrome|firefox|firefox-esr|navigator)\"' || exit 4",
    "eval \"$(xdotool getwindowgeometry --shell \"$w\" 2>/dev/null | grep -E '^(X|Y|WIDTH|HEIGHT)=-?[0-9]+$')\"",
    `[ -n "$WIDTH" ] && [ ${x} -ge "$X" ] && [ ${x} -lt $((X + WIDTH)) ] && [ ${y} -ge $((Y + ${SECURE_TOOLBAR_PX})) ] && [ ${y} -lt $((Y + HEIGHT)) ] || exit 8`,
    "printf '' | xclip -selection clipboard",
    "xdotool key --clearmodifiers ctrl+l",
    "sleep 0.3",
    "xdotool key --clearmodifiers ctrl+c",
    "sleep 0.3",
    "u=$(xclip -o -selection clipboard 2>/dev/null | head -c 2048 | tr -d '\\r\\n')",
    "printf '' | xclip -selection clipboard",
    "xdotool key --clearmodifiers Escape",
    "case \"$u\" in https://*) ;; http://*) exit 6;; *) exit 5;; esac",
    "h=${u#https://}; h=${h%%[/?#]*}; h=${h##*@}; h=${h%%:*}; h=$(printf %s \"$h\" | tr 'A-Z' 'a-z'); h=${h%.}",
    `case "$h" in ${quote(host)}|*.${quote(host)}) ;; *) printf 'HOST=%s\\n' "$h"; exit 7;; esac`,
    `xdotool mousemove --sync ${x} ${y} click 1 || exit 9`,
    "sleep 0.2",
    "[ \"$(xdotool getactivewindow 2>/dev/null)\" = \"$w\" ] || exit 10",
    "xdotool key --clearmodifiers ctrl+a",
    `printf %s ${quote(encoded)} | base64 -d | xclip -selection clipboard || exit 11`,
    "i=0",
    `until [ "$(xclip -o -selection clipboard 2>/dev/null | base64 | tr -d '\\n')" = ${quote(encoded)} ]; do i=$((i + 1)); [ "$i" -lt 5 ] || { printf '' | xclip -selection clipboard; exit 12; }; sleep 0.1; done`,
    "xdotool key --clearmodifiers ctrl+v",
    "s=$?",
    "sleep 0.5",
    "printf '' | xclip -selection clipboard",
    "[ \"$s\" = 0 ] || exit 11",
    ...(input.submit ? ["sleep 0.2", "xdotool key --clearmodifiers Return"] : []),
    "exit 0",
  ].join("\n");
}

const NOT_CONFIRMED = "Typing did not finish, so the field may be empty or partly filled. Take a screenshot to check the page.";

export function secureFillProblem(exitCode: number | null, stdout: string, formHost: string): string {
  switch (exitCode) {
    case 3:
      return "No window is active on the cloud computer, so nothing was typed. Take a screenshot and bring the browser to the front.";
    case 4:
      return "The active window is not the web browser, so nothing was typed. Bring the browser with the sign-in page to the front, then try again.";
    case 5:
      return "later.dog could not read the browser's address, so nothing was typed. If the sign-in is in a popup or an app window, ask with request_takeover instead.";
    case 6:
      return "The page is not using HTTPS, so nothing was typed.";
    case 7: {
      const page = /^HOST=([a-z0-9.-]{1,253})$/m.exec(stdout)?.[1];
      return page
        ? `The browser is on ${page}, not ${formHost}, so nothing was typed. Go back to the sign-in page on ${formHost}; if ${page} is the right site, ask again with request_secure_form.`
        : `The browser is not on ${formHost}, so nothing was typed. Go back to the sign-in page on ${formHost}.`;
    }
    case 8:
      return "That point is not on the page area of the browser window, below its address bar, so nothing was typed. Take a screenshot and use the field's position.";
    case 9:
      return "The click on the field did not go through, so nothing was typed. Take a screenshot and try again.";
    case 10:
      return "Another window took focus after the click, so nothing was typed. Take a screenshot and try again.";
    case 12:
      return "The cloud computer's clipboard did not take the value, so nothing was typed. Call fill_secure_field again.";
    default:
      return NOT_CONFIRMED;
  }
}

export interface SecureFormDesk {
  open(input: SecureFormInput): { formId: string; filled?: SecureFormCardData } | { error: string };
  field(formId: string, fieldId: string): { ok: true; host: string; label: string; value: string } | { ok: false; text: string };
  typed(formId: string, fieldId: string): { last: boolean };
}

export type SecureFillRun = (command: string) => Promise<{ ok: boolean; exitCode: number | null; stdout: string }>;

export async function fillSecureField(args: Record<string, unknown>, desk: SecureFormDesk, run: SecureFillRun): Promise<{ ok: boolean; text: string }> {
  const formId = String(args.form_id ?? "");
  const field = String(args.field_id ?? "");
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, text: "x and y must be whole pixel positions on the screenshot." };
  const submit = args.submit === true;
  const slot = desk.field(formId, field);
  if (!slot.ok) return { ok: false, text: slot.text };
  let result: Awaited<ReturnType<SecureFillRun>>;
  try {
    result = await run(secureFillCommand({ host: slot.host, x, y, value: slot.value, submit }));
  } catch {
    return { ok: false, text: NOT_CONFIRMED };
  }
  if (!result.ok || result.exitCode !== 0) return { ok: false, text: secureFillProblem(result.exitCode, result.stdout, slot.host) };
  const { last } = desk.typed(formId, field);
  return {
    ok: true,
    text: [
      `Typed ${slot.label} into the page on ${slot.host}${submit ? " and pressed Enter" : ""}. You never see the value.`,
      last ? "Every field in this form is now typed." : "",
      "Take a screenshot to check the page.",
    ].filter(Boolean).join(" "),
  };
}

export function secureFormRequestedText(formId: string): string {
  return [
    `The person now sees a Secure Form card (form_id ${JSON.stringify(formId)}).`,
    "End this turn now with one short, friendly line, for example: \"Tap Open, fill in your details, then tap Continue.\"",
    "Never ask for passwords or codes in chat.",
    "later.dog wakes you when they press Continue; then type each value with fill_secure_field.",
  ].join(" ");
}

export function secureFormFilledText(card: SecureFormCardData, formId: string): string {
  const fields = card.fields.map((field) => `${field.id} (${field.label})`).join(", ");
  return [
    `The person keeps a login for ${card.host} in their vault and lets you use it without asking, so this Secure Form is already filled (form_id ${JSON.stringify(formId)}).`,
    `Take a screenshot, then call fill_secure_field for each field: ${fields}. You never see the values.`,
    "Set submit to true on the last field, then take a screenshot to check the result.",
  ].join(" ");
}

export function secureFormResumePrompt(card: SecureFormCardData, formId: string): string {
  const fields = card.fields.filter((field) => !field.filled).map((field) => `${field.id} (${field.label})`).join(", ");
  const empty = card.fields.filter((field) => field.filled).map((field) => field.label);
  return [
    `later.dog secure form update: the person filled in ${JSON.stringify(card.title)} for ${card.host}.`,
    `Take a screenshot, then call fill_secure_field with form_id ${JSON.stringify(formId)} for each field: ${fields}.`,
    empty.length ? `They left ${empty.join(", ")} empty: leave ${empty.length === 1 ? "that box" : "those boxes"} on the page as ${empty.length === 1 ? "it is" : "they are"}.` : "",
    "Give the x, y of each field on the page; later.dog checks the site, clicks the field and types the value. You never see the values.",
    "Set submit to true on the last field of each step, then take a screenshot to check the result.",
    "If the site then asks for something new, such as a verification code, ask with request_secure_form again. Never ask for these details in chat.",
  ].filter(Boolean).join(" ");
}

export function secureFormMessageText(card: Pick<SecureFormCardData, "title" | "host">): string {
  return `Secure Form: ${card.title} (${card.host})`;
}

export interface SecureFormMessage {
  id: string;
  kind: string;
  from?: { botId?: string };
  secureForm?: SecureFormCardData;
}

export interface SecureFormSavedLogins {
  matching(host: string): readonly VaultLogin[];
  credentials(id: string): { site: string; username: string; password: string } | null;
  addDetails?(details: VaultDetails): void;
  save(input: { site: string; username: string; password: string }): void;
}

export interface SecureFormHost {
  inThread(botId: string, threadId: string): { group: boolean } | null;
  messages(threadId: string): readonly SecureFormMessage[];
  append(botId: string, threadId: string, card: SecureFormCardData, options?: { quiet?: boolean }): string;
  patch(threadId: string, messageId: string, card: SecureFormCardData): void;
  resume(entry: { botId: string; threadId: string; messageId: string; prompt: string }): void;
  savedLogins?: SecureFormSavedLogins;
  allows?(botId: string, threadId: string, key: string): boolean;
  grant?(botId: string, threadId: string, key: string): void;
}

export type SecureFormSubmit =
  | { ok: true; card: SecureFormCardData; saved?: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string };

const formKey = (threadId: string, messageId: string) => `${threadId}:${messageId}`;
const bareField = (field: SecureFormField): SecureFormField => ({
  id: field.id,
  label: field.label,
  type: field.type,
  ...(field.autocomplete ? { autocomplete: field.autocomplete } : {}),
  ...(field.optional ? { optional: true } : {}),
});

function loginValues(plan: VaultFieldPlan, login: { username: string; password: string }): Map<string, string> | null {
  const values = new Map<string, string>();
  if (plan.username) {
    if (!login.username) return null;
    values.set(plan.username, login.username);
  }
  if (plan.password) values.set(plan.password, login.password);
  return values;
}

export class SecureForms {
  private readonly vault = new SecureFormVault((key) => this.expire(key));
  private readonly sent = new Map<string, { botId: string; threadId: string; messageId: string }>();
  private readonly typings = new Map<string, Map<string, number>>();
  private readonly host: SecureFormHost;
  private readonly now: () => number;

  constructor(host: SecureFormHost, now: () => number = Date.now) {
    this.host = host;
    this.now = now;
  }

  desk(botId: string, threadId: string): SecureFormDesk {
    return {
      open: (input) => this.open(botId, threadId, input),
      field: (formId, field) => this.field(botId, threadId, formId, field),
      typed: (formId, field) => this.typed(botId, threadId, formId, field),
    };
  }

  submit(botId: string, threadId: string, messageId: string, raw: unknown, options: { save?: boolean } = {}): SecureFormSubmit {
    const card = this.openCard(botId, threadId, messageId);
    if ("error" in card) return card;
    const values = parseSecureValues(card.fields, raw);
    if (!(values instanceof Map)) return { ok: false, status: 400, error: values.error };
    const saved = options.save ? (asksForDetails(card.fields) ? this.saveDetails(card, values) : this.saveLogin(card, values)) : undefined;
    return { ok: true, card: this.send(botId, threadId, messageId, card, values), ...(saved === undefined ? {} : { saved }) };
  }

  useSaved(botId: string, threadId: string, messageId: string, choice: { login: string; always?: boolean }): SecureFormSubmit {
    const card = this.openCard(botId, threadId, messageId);
    if ("error" in card) return card;
    const vault = this.host.savedLogins;
    const plan = vaultFieldPlan(card.fields);
    if (!vault || !plan) return { ok: false, status: 400, error: "A saved login can't fill this form." };
    if (!vault.matching(card.host).some((login) => login.id === choice.login)) {
      return { ok: false, status: 404, error: `That login isn't saved for ${card.host}.` };
    }
    const login = vault.credentials(choice.login);
    if (!login || vaultSite(card.host) !== login.site) return { ok: false, status: 404, error: "That login is no longer in your vault." };
    const values = loginValues(plan, login);
    if (!values) return { ok: false, status: 400, error: "That saved login has no username to type here." };
    if (choice.always) this.host.grant?.(botId, threadId, vaultAllowKey(login.site));
    return { ok: true, card: this.send(botId, threadId, messageId, card, values, { username: login.username }) };
  }

  private openCard(botId: string, threadId: string, messageId: string): SecureFormCardData | { ok: false; status: 404 | 409; error: string } {
    const card = this.find(botId, threadId, messageId);
    if (!card) return { ok: false, status: 404, error: "This form is no longer available." };
    if (card.status !== "open") {
      return { ok: false, status: 409, error: card.status === "superseded" ? "A newer form replaced this one." : "This form was already sent." };
    }
    return card;
  }

  private send(botId: string, threadId: string, messageId: string, card: SecureFormCardData, values: Map<string, string>, saved?: { username: string }): SecureFormCardData {
    this.hold(botId, threadId, messageId, values);
    const next = this.sending(card, saved, values);
    this.host.patch(threadId, messageId, next);
    this.host.resume({ botId, threadId, messageId, prompt: secureFormResumePrompt(next, messageId) });
    return next;
  }

  private hold(botId: string, threadId: string, messageId: string, values: Map<string, string>): void {
    const key = formKey(threadId, messageId);
    this.vault.hold(key, values, SECURE_FORM_TTL_MS);
    this.sent.set(key, { botId, threadId, messageId });
    this.typings.delete(key);
  }

  private sending(card: SecureFormCardData, saved?: { username: string }, values?: ReadonlyMap<string, string>): SecureFormCardData {
    const fields = card.fields.map((field) => (values && field.optional && !values.has(field.id) ? { ...bareField(field), filled: true } : bareField(field)));
    return { ...card, fields, status: "sending", until: this.now() + SECURE_FORM_TTL_MS, ...(saved ? { saved } : {}) };
  }

  private saveDetails(card: SecureFormCardData, values: Map<string, string>): boolean {
    const details = detailsFromForm(card.fields, values);
    if (!this.host.savedLogins?.addDetails || !Object.keys(details).length) return false;
    try {
      this.host.savedLogins.addDetails(details);
      return true;
    } catch {
      return false;
    }
  }

  private saveLogin(card: SecureFormCardData, values: Map<string, string>): boolean {
    const vault = this.host.savedLogins;
    const plan = vaultFieldPlan(card.fields);
    if (!vault || !plan?.username || !plan.password || !savesAsLogin(card.fields)) return false;
    try {
      vault.save({ site: card.host, username: values.get(plan.username)!, password: values.get(plan.password)! });
      return true;
    } catch {
      return false;
    }
  }

  private allowedLogin(botId: string, threadId: string, card: SecureFormCardData): { values: Map<string, string>; username: string } | null {
    const vault = this.host.savedLogins;
    const plan = vaultFieldPlan(card.fields);
    if (!vault || !plan) return null;
    const logins = vault.matching(card.host);
    if (logins.length !== 1 || this.host.allows?.(botId, threadId, vaultAllowKey(logins[0]!.site)) !== true) return null;
    const login = vault.credentials(logins[0]!.id);
    const values = login ? loginValues(plan, login) : null;
    return login && values ? { values, username: login.username } : null;
  }

  private find(botId: string, threadId: string, messageId: string): SecureFormCardData | null {
    const owner = this.host.inThread(botId, threadId);
    if (!owner) return null;
    const message = this.host.messages(threadId).find((candidate) => candidate.id === messageId);
    if (message?.kind !== "secret" || !message.secureForm) return null;
    if (owner.group && message.from?.botId !== botId) return null;
    return message.secureForm;
  }

  private drop(key: string): void {
    this.vault.forget(key);
    this.sent.delete(key);
    this.typings.delete(key);
  }

  private open(botId: string, threadId: string, input: SecureFormInput): { formId: string; filled?: SecureFormCardData } | { error: string } {
    const owner = this.host.inThread(botId, threadId);
    if (!owner) return { error: "This conversation is not available for a Secure Form." };
    for (const message of this.host.messages(threadId)) {
      const card = message.kind === "secret" ? message.secureForm : undefined;
      if (!card || !isOpenSecureForm(card.status) || (owner.group && message.from?.botId !== botId)) continue;
      this.drop(formKey(threadId, message.id));
      this.host.patch(threadId, message.id, { ...card, status: "superseded" });
    }
    const card: SecureFormCardData = { title: input.title, host: input.host, fields: input.fields.map(bareField), status: "open" };
    const allowed = this.allowedLogin(botId, threadId, card);
    if (!allowed) return { formId: this.host.append(botId, threadId, card) };
    const filled = this.sending(card, { username: allowed.username });
    const formId = this.host.append(botId, threadId, filled, { quiet: true });
    this.hold(botId, threadId, formId, allowed.values);
    return { formId, filled };
  }

  private field(botId: string, threadId: string, formId: string, field: string): ReturnType<SecureFormDesk["field"]> {
    const card = this.find(botId, threadId, formId);
    if (!card) return { ok: false, text: "There is no Secure Form with that form_id in this conversation. Use the form_id from request_secure_form." };
    if (card.status === "open") return { ok: false, text: "The person has not filled in this form yet. End your turn; later.dog wakes you when they press Continue." };
    if (card.status === "superseded") return { ok: false, text: "A newer Secure Form replaced this one. Use the newest form_id." };
    const entry = card.fields.find((candidate) => candidate.id === field);
    if (!entry) return { ok: false, text: `This form has no field ${JSON.stringify(field)}. Its fields are ${card.fields.map((candidate) => candidate.id).join(", ")}.` };
    const key = formKey(threadId, formId);
    const value = this.vault.value(key, field);
    if (value === undefined && entry.optional && entry.filled && this.vault.has(key)) {
      return { ok: false, text: `${entry.label} was left empty, so there is nothing to type: leave that box on the page as it is.` };
    }
    if (value === undefined) {
      if (card.status === "sending") this.host.patch(threadId, formId, { ...card, status: "expired" });
      return { ok: false, text: "The details from this form were cleared. If they are still needed, ask again with request_secure_form." };
    }
    if ((this.typings.get(key)?.get(field) ?? 0) >= SECURE_FIELD_MAX_TYPINGS) {
      return { ok: false, text: `${entry.label} was already typed ${SECURE_FIELD_MAX_TYPINGS} times. If it is still needed, ask again with request_secure_form.` };
    }
    return { ok: true, host: card.host, label: entry.label, value };
  }

  private typed(botId: string, threadId: string, formId: string, field: string): { last: boolean } {
    const key = formKey(threadId, formId);
    const counts = this.typings.get(key) ?? new Map<string, number>();
    counts.set(field, (counts.get(field) ?? 0) + 1);
    this.typings.set(key, counts);
    const card = this.find(botId, threadId, formId);
    if (!card || card.status !== "sending") return { last: false };
    const fields = card.fields.map((candidate) => (candidate.id === field ? { ...candidate, filled: true } : candidate));
    const last = fields.every((candidate) => candidate.filled);
    if (last) this.vault.shorten(key, SECURE_FORM_AFTER_FILLED_MS);
    this.host.patch(threadId, formId, { ...card, fields, status: last ? "filled" : "sending" });
    return { last };
  }

  private expire(key: string): void {
    const owner = this.sent.get(key);
    this.sent.delete(key);
    this.typings.delete(key);
    if (!owner) return;
    const card = this.find(owner.botId, owner.threadId, owner.messageId);
    if (card?.status === "sending") this.host.patch(owner.threadId, owner.messageId, { ...card, status: "expired" });
  }
}
