import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CURATED_TOOLKITS } from "../../server/composio";
import { APP_ICON_FILES } from "./app-icon-files";
import { appIconUrl } from "./app-icons";
import { brandMark } from "./brand-icons";
import { MCP_CONNECTORS } from "./mcp-connector-catalog";

const HAS_NO_ICON_ANYWHERE = new Set(["dida365.com"]);

describe("app icons ship with later.dog", () => {
  it("has an icon for every app that has no drawn mark", () => {
    const needed = new Set([
      ...MCP_CONNECTORS.filter((connector) => !brandMark(connector.id)).map((connector) => connector.domain),
      ...CURATED_TOOLKITS.filter((card) => card.domain && !brandMark(card.slug)).map((card) => card.domain!),
    ]);
    const missing = [...needed].filter((domain) => !APP_ICON_FILES[domain] && !HAS_NO_ICON_ANYWHERE.has(domain));
    expect(missing, "node scripts/fetch-app-icons.ts bundles them").toEqual([]);
  });

  it("lists exactly the files in public/app-icons", () => {
    const files = Object.values(APP_ICON_FILES);
    for (const file of files) expect(existsSync(`public/app-icons/${file}`), file).toBe(true);
    expect(readdirSync("public/app-icons").sort()).toEqual([...files].sort());
  });

  it("serves icons from later.dog itself", () => {
    expect(appIconUrl("deepwiki.com")).toBe("/app-icons/deepwiki.com.png");
    expect(appIconUrl("nowhere.example")).toBeUndefined();
    expect(appIconUrl(null)).toBeUndefined();
  });
});
