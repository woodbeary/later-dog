import { describe, expect, it } from "vitest";
import { redactTrace, redactTraceYielding, secretForms } from "./trace-scrub.ts";

const alnum = (length: number, seed = "aB3xY9") => seed.repeat(Math.ceil(length / seed.length)).slice(0, length);

describe("trace scrubbing by shape", () => {
  const shapes: [string, string][] = [
    ["an Anthropic key", `sk-ant-api03-${alnum(60)}`],
    ["an OpenAI key", `sk-${alnum(48)}`],
    ["an OpenAI project key", `sk-proj-${alnum(60)}`],
    ["an xAI key", `xai-${alnum(60)}`],
    ["a Slack bot token", `xoxb-1234567890-${alnum(24)}`],
    ["a Slack user token", `xoxp-1234567890-${alnum(24)}`],
    ["a Google API key", `AIza${alnum(35)}`],
    ["a Stripe live secret key", `sk_live_${alnum(24)}`],
    ["a Stripe restricted key", `rk_live_${alnum(24)}`],
    ["a later.dog computers key", `ldc_${alnum(40)}`],
    ["a later.dog token", `ldt_${alnum(40)}`],
    ["a Cloudflare user token", `cfut_${alnum(40)}`],
    ["an AWS access key id", ["AKIA", "IOSFODNN7EXAMPLE"].join("")],
    ["an AWS session key id", ["ASIA", "IOSFODNN7EXAMPLE"].join("")],
    ["a GitHub token", `ghp_${alnum(36)}`],
    ["a GitHub fine-grained token", `github_pat_${alnum(50)}`],
  ];
  for (const [name, secret] of shapes) {
    it(`blanks ${name}`, () => {
      const clean = redactTrace(`{"type":"user","text":"the value is ${secret} and then more"}`, []);
      expect(clean).not.toContain(secret);
      expect(clean).toContain("[redacted]");
      expect(clean).toContain("and then more");
    });
  }

  it("blanks a Bearer header and keeps the word", () => {
    const clean = redactTrace('curl -H "Authorization: Bearer abcdef1234567890.ghijkl-mnop_qrst" https://x.test', []);
    expect(clean).toContain("Bearer [redacted]");
    expect(clean).not.toContain("abcdef1234567890");
  });

  it("blanks a whole PEM private key, in plain text and inside a JSON string", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\nZZZZ\n-----END RSA PRIVATE KEY-----";
    const plain = redactTrace(`before\n${pem}\nafter`, []);
    expect(plain).toBe("before\n[redacted]\nafter");
    const inJson = redactTrace(JSON.stringify({ text: `key: ${pem}` }), []);
    expect(inJson).not.toContain("MIIEow");
    expect(JSON.parse(inJson).text).toBe("key: [redacted]");
    const cut = redactTrace(JSON.stringify({ text: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA" }), []);
    expect(cut).not.toContain("b3BlbnNz");
  });

  it("blanks the value of NAME=value for names holding TOKEN, SECRET, KEY, PASSWORD, PASSWD, CREDENTIAL or AUTH", () => {
    for (const name of ["GH_TOKEN", "CLIENT_SECRET", "STRIPE_API_KEY", "DB_PASSWORD", "MYSQL_PASSWD", "AWS_CREDENTIALS", "BASIC_AUTH", "my_token"]) {
      const clean = redactTrace(`export ${name}=hunter2-value-9 && run`, []);
      expect(clean, name).toBe(`export ${name}=[redacted] && run`);
    }
    expect(redactTrace('{"cmd":"TOKEN=\\"abc12345\\" node x.js"}', [])).toBe('{"cmd":"TOKEN=\\"[redacted]\\" node x.js"}');
    expect(redactTrace("https://x.test/cb?api_key=abc123def456&z=1", [])).toBe("https://x.test/cb?api_key=[redacted]&z=1");
  });

  it("blanks the value of a JSON field whose name holds one of those words", () => {
    const clean = redactTrace('{"access_token": "abc.def.ghi-123","password":"correct horse","clientSecret":"s3cr3t-value","authorization":"Basic dXNlcjpwYXNz","name":"keep me"}', []);
    expect(clean).toBe('{"access_token": "[redacted]","password":"[redacted]","clientSecret":"[redacted]","authorization":"[redacted]","name":"keep me"}');
  });
});

describe("trace scrubbing of known secrets", () => {
  const secret = "Zq8!known/secret+value=1234567890";

  it("blanks the exact value and its base64, base64url and URL-encoded copies", () => {
    const forms = [
      secret,
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64url"),
      encodeURIComponent(secret),
      encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
      JSON.stringify(secret).slice(1, -1),
    ];
    for (const form of forms) {
      const clean = redactTrace(`line before ${form} line after`, [secret]);
      expect(clean, form).toBe("line before [redacted] line after");
    }
  });

  it("blanks a base64 copy that sits inside a longer encoded string at any alignment", () => {
    for (const prefix of ["", "a", "ab", "abc", "user:"]) {
      const encoded = Buffer.from(`${prefix}${secret}:tail`).toString("base64");
      const clean = redactTrace(`Authorization-ish ${encoded}`, [secret]);
      expect(clean, prefix).toContain("[redacted]");
      expect(clean, prefix).not.toContain(Buffer.from(secret).toString("base64").slice(4, -4));
    }
  });

  it("ignores secrets too short to match safely, and blank ones", () => {
    expect(secretForms("short")).toEqual([]);
    expect(secretForms("   ")).toEqual([]);
    expect(redactTrace("a short word", ["short"])).toBe("a short word");
  });

  it("blanks the computers key and the later.dog token the supervisor holds", () => {
    const computers = `ldc_${alnum(30, "k9Q")}`;
    const dog = "dog-token-with-no-known-prefix-123456";
    const clean = redactTrace(`${computers} then ${dog} then ${Buffer.from(dog).toString("base64")}`, [computers, dog]);
    expect(clean).toBe("[redacted] then [redacted] then [redacted]");
  });
});

describe("trace scrubbing leaves ordinary lines alone", () => {
  const ordinary = [
    '{"type":"system","subtype":"init","apiKeySource":"none","model":"claude-opus-5-5","session_id":"5f2d8c0e-1111-4222-8333-444455556666"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"I ran the tests: 214 passed, 0 failed, then pushed commit 3f2a9c1d8b7e6a5f4c3b2a1908f7e6d5c4b3a291."}]}}',
    "commit 3f2a9c1d8b7e6a5f4c3b2a1908f7e6d5c4b3a291\nAuthor: Jacob <jacob@txtclaw.com>\nDate:   Wed Oct 14 2026",
    '{"headSha":"3f2a9c1d8b7e6a5f4c3b2a1908f7e6d5c4b3a291","baseSha":"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678","author":"woodbeary"}',
    "Press the keyboard shortcut or the key sequence in the keyframes list; the task-based-implementation-of-things-for-the-whole-repo is done",
    "monkey patching works; keyword=value pairs are fine; authors=3 reviewers=2",
    "git log --oneline -5 && pnpm exec vitest run server/laterdog/job-trace.test.ts",
    '{"type":"result","subtype":"success","is_error":false,"duration_ms":183422,"num_turns":31,"total_cost_usd":1.27}',
  ];
  for (const line of ordinary) {
    it(`keeps ${line.slice(0, 48)}...`, () => {
      expect(redactTrace(line, [])).toBe(line);
    });
  }
});

describe("trace scrubbing in batches", () => {
  it("scrubs a large text the same way, line by line, while yielding", async () => {
    const secret = `sk-ant-oat01-${alnum(90)}`;
    const line = `{"n":1,"pad":"${"x".repeat(990)}"}\n`;
    const text = `${line.repeat(3000)}{"out":"${secret}"}\n${line.repeat(10)}`;
    const clean = await redactTraceYielding(text, [secret]);
    expect(clean).toBe(redactTrace(text, [secret]));
    expect(clean).not.toContain(secret);
    expect(clean.split("\n")).toHaveLength(text.split("\n").length);
  });
});
