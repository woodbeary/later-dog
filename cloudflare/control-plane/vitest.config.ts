import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const TEST_AUTH_SECRET = "test-only-better-auth-secret-with-more-than-32-characters";
const TEST_CLOUDFLARE_TOKEN = "test-only-cloudflare-api-token-with-no-real-access";
process.env.BETTER_AUTH_SECRET ??= TEST_AUTH_SECRET;
process.env.CLOUDFLARE_API_TOKEN ??= TEST_CLOUDFLARE_TOKEN;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) },
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
          CLOUDFLARE_API_TOKEN: TEST_CLOUDFLARE_TOKEN,
          CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
          CLOUDFLARE_ZONE_ID: "fedcba9876543210fedcba9876543210",
          MANAGED_ENDPOINTS: "on",
          ALLOWED_ORIGINS: "https://app.laterdog.test",
          REVIEW_EMAIL: "appreview@later.dog",
          REVIEW_SIGNIN_CODE: "31415926",
          LATERDOG_TUNNEL_RECLAIM: "on",
          TEST_MIGRATIONS: await readD1Migrations(`${root}migrations`),
        },
        serviceBindings: {
          HOMES: { name: "homes-stub", entrypoint: "HomesApi" },
        },
        workers: [
          { name: "homes-stub", modules: true, scriptPath: `${root}test/homes-stub.js`, compatibilityDate: "2026-08-25" },
        ],
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
