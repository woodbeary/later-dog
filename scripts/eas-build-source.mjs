import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export async function easBuildSource(cliPath, buildId) {
  if (!/^[a-f0-9-]{36}$/i.test(buildId)) throw new Error("An exact EAS build ID is required.");
  let root = dirname(realpathSync(cliPath));
  for (;;) {
    const manifest = join(root, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "eas-cli") break;
    const parent = dirname(root);
    if (parent === root) throw new Error("Could not locate the selected EAS CLI installation.");
    root = parent;
  }
  const require = createRequire(join(root, "package.json"));
  const SessionManager = require("./build/user/SessionManager").default;
  const session = new SessionManager({ setActor() {} });
  const { createGraphqlClient } = require("./build/commandUtils/context/contextUtils/createGraphqlClient");
  const client = createGraphqlClient({ accessToken: session.getAccessToken(), sessionSecret: session.getSessionSecret() });
  const result = await client.query("query ReleaseBuildSource($buildId: ID!) { builds { byId(buildId: $buildId) { id isGitWorkingTreeDirty } } }", { buildId }, { requestPolicy: "network-only", noRetry: true }).toPromise();
  if (result.error || result.data?.builds?.byId?.id !== buildId) throw new Error("The authenticated EAS clean-source record could not be verified.");
  return result.data.builds.byId;
}
