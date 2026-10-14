const MIN_SECRET_LENGTH = 8;
const REDACTED = "[redacted]";
const SENSITIVE_WORDS = "(?:TOKEN|SECRET|KEY(?!BOARD|WORD|STROKE|FRAME)|PASSWORD|PASSWD|CREDENTIAL|AUTH(?!OR(?!IZ)|ENTICATED))";
const ASSIGNMENT_NAME = `[A-Za-z0-9_.-]*${SENSITIVE_WORDS}[A-Za-z0-9_.-]*`;
const PLACEHOLDER_VALUES = new Set(["none", "null", "true", "false", "undefined", "string", "redacted", "[redacted]", "***", "<redacted>"]);

const PREFIXED_SECRETS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])xai-[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{35}/g,
  /(?<![A-Za-z0-9])(?:sk|rk)_live_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9])ld[ct]_[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])cfut_[A-Za-z0-9]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{30,}/g,
];

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[^"']*)/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const ENV_ASSIGNMENT = new RegExp(`(?<![A-Za-z0-9_.-])(${ASSIGNMENT_NAME}=)((?:\\\\?["'])?)([^\\s"'\\\\,;&)]{4,})`, "gi");
const JSON_ASSIGNMENT = new RegExp(`("${ASSIGNMENT_NAME}"\\s*:\\s*")((?:[^"\\\\]|\\\\.){4,})(")`, "gi");

function placeholder(value: string): boolean {
  return PLACEHOLDER_VALUES.has(value.toLowerCase());
}

function base64Forms(secret: string): string[] {
  const forms: string[] = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const bytes = Buffer.concat([Buffer.alloc(offset, 0x41), Buffer.from(secret, "utf8")]);
    const full = Math.floor((bytes.length * 8) / 6);
    const skip = Math.ceil((offset * 8) / 6);
    const standard = bytes.toString("base64").replace(/=+$/, "").slice(skip, full);
    if (standard.length >= MIN_SECRET_LENGTH) forms.push(standard, standard.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return forms;
}

export function secretForms(secret: string): string[] {
  const trimmed = secret.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return [];
  const encoded = encodeURIComponent(trimmed);
  const forms = new Set<string>([
    trimmed,
    encoded,
    encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    encodeURI(trimmed),
    JSON.stringify(trimmed).slice(1, -1),
    ...base64Forms(trimmed),
    Buffer.from(trimmed, "utf8").toString("base64"),
    Buffer.from(trimmed, "utf8").toString("base64url"),
  ]);
  return [...forms].filter((form) => form.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

export function scrubber(secrets: readonly string[]): (text: string) => string {
  const forms = secrets.flatMap(secretForms).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const form of forms) out = out.split(form).join(REDACTED);
    out = out.replace(PRIVATE_KEY_BLOCK, REDACTED);
    for (const shape of PREFIXED_SECRETS) out = out.replace(shape, REDACTED);
    out = out.replace(BEARER, (_whole, prefix: string) => `${prefix}${REDACTED}`);
    out = out.replace(ENV_ASSIGNMENT, (whole, name: string, quote: string, value: string) => (placeholder(value) ? whole : `${name}${quote}${REDACTED}`));
    return out.replace(JSON_ASSIGNMENT, (whole, open: string, value: string, close: string) => (placeholder(value) ? whole : `${open}${REDACTED}${close}`));
  };
}

export function redactTrace(text: string, secrets: readonly string[]): string {
  return scrubber(secrets)(text);
}

const BATCH_CHARS = 1_000_000;

export async function redactTraceYielding(text: string, secrets: readonly string[]): Promise<string> {
  const scrub = scrubber(secrets);
  const lines = text.split("\n");
  const clean: string[] = [];
  let batch: string[] = [];
  let size = 0;
  const flush = async () => {
    if (batch.length) clean.push(scrub(batch.join("\n")));
    batch = [];
    size = 0;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  for (const line of lines) {
    batch.push(line);
    size += line.length + 1;
    if (size >= BATCH_CHARS) await flush();
  }
  await flush();
  return clean.join("\n");
}
