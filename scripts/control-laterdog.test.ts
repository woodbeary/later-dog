import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { verificationServerEnvironment } from "./control-laterdog.ts";

const childEnv = (parentEnv: NodeJS.ProcessEnv) =>
  verificationServerEnvironment(parentEnv, join(tmpdir(), "laterdog-fixture-env"), 9100);

describe("the fixture's Live call environment", () => {
  it("passes a loopback fake GPT-Live and its key through", () => {
    expect(
      childEnv({
        LATERDOG_OPENAI_LIVE_URL: " http://127.0.0.1:4100 ",
        LATERDOG_OPENAI_LIVE_KEY: "sk-fake",
      }),
    ).toMatchObject({
      LATERDOG_OPENAI_LIVE_URL: "http://127.0.0.1:4100",
      LATERDOG_OPENAI_LIVE_KEY: "sk-fake",
    });
    const noKey = childEnv({ LATERDOG_OPENAI_LIVE_URL: "http://127.0.0.1:4100" });
    expect(noKey.LATERDOG_OPENAI_LIVE_URL).toBe("http://127.0.0.1:4100");
    expect(noKey).not.toHaveProperty("LATERDOG_OPENAI_LIVE_KEY");
  });

  it("drops any other Live URL, and never lets the key cross without the fake", () => {
    for (const url of [
      "https://api.openai.com",
      "http://localhost:4100",
      "http://127.0.0.1:4100/v1",
      "http://192.0.2.1:4100",
      "http://127.0.0.1",
      "",
    ]) {
      const env = childEnv({ LATERDOG_OPENAI_LIVE_URL: url, LATERDOG_OPENAI_LIVE_KEY: "sk-real" });
      expect(env, url).not.toHaveProperty("LATERDOG_OPENAI_LIVE_URL");
      expect(env, url).not.toHaveProperty("LATERDOG_OPENAI_LIVE_KEY");
    }
    expect(childEnv({ LATERDOG_OPENAI_LIVE_KEY: "sk-real" })).not.toHaveProperty(
      "LATERDOG_OPENAI_LIVE_KEY",
    );
  });
});

describe("the fixture's computer job checks", () => {
  it("passes a whole number of milliseconds between checks through, and nothing else", () => {
    expect(
      childEnv({ LATERDOG_COMPUTER_JOB_CHECK_MS: "3600000" }).LATERDOG_COMPUTER_JOB_CHECK_MS,
    ).toBe("3600000");
    for (const value of ["", "0", "-5", "1e9", "30s", "1000000000", " 1000"])
      expect(childEnv({ LATERDOG_COMPUTER_JOB_CHECK_MS: value }), value).not.toHaveProperty(
        "LATERDOG_COMPUTER_JOB_CHECK_MS",
      );
  });
});

describe("the fixture's memory budget", () => {
  it("sets an ample deterministic budget in sealed verification mode", () => {
    expect(childEnv({ LATERDOG_TEST_SEALED_PATH: "0", NODE_OPTIONS: "--inspect" })).toMatchObject({
      LATERDOG_TEST_SEALED_PATH: "1",
      LATERDOG_TEST_AVAILABLE_MEMORY_BYTES: String(4 * 1024 ** 3),
    });
    expect(childEnv({ NODE_OPTIONS: "--inspect" })).not.toHaveProperty("NODE_OPTIONS");
  });

  it("allows explicit low-memory fixtures and rejects malformed readings", () => {
    expect(
      childEnv({ LATERDOG_TEST_AVAILABLE_MEMORY_BYTES: "0" }).LATERDOG_TEST_AVAILABLE_MEMORY_BYTES,
    ).toBe("0");
    for (const bytes of ["", "-1", " 1000", "1.5", "1e9", "Infinity", "9007199254740992"]) {
      expect(
        childEnv({ LATERDOG_TEST_AVAILABLE_MEMORY_BYTES: bytes })
          .LATERDOG_TEST_AVAILABLE_MEMORY_BYTES,
      ).toBe(String(4 * 1024 ** 3));
    }
  });
});
