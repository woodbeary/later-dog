import { join } from "node:path";
import { loadSupervisorConfig, supervisorDataDir, supervisorToken } from "./config.ts";
import { createSupervisorServer } from "./http.ts";
import { WorkspaceStore } from "./store.ts";
import { Supervisor, message } from "./supervisor.ts";

const dataDir = supervisorDataDir(); const store = new WorkspaceStore(join(dataDir,"workspace.sqlite"));
const supervisor = new Supervisor(store,{ dataDir, ...loadSupervisorConfig(dataDir) });
const server = createSupervisorServer(supervisor,supervisorToken(dataDir));
const port = Number(process.env.LATERDOG_PORT ?? 9010);
server.on("error",(error: NodeJS.ErrnoException) => {
  // A second desktop or supervisor on the same port is a configuration fact worth stating; a bare EADDRINUSE stack is not.
  console.error(error.code === "EADDRINUSE"
    ? `later.dog supervisor: port ${port} is already in use by another supervisor (a second pnpm laterdog:dev, or pnpm laterdog:supervisor). Stop it, or save a hosted connection in ~/.laterdog/supervisor.json so this desktop does not start one.`
    : message(error));
  process.exit(1);
});
server.listen(port,process.env.LATERDOG_BIND ?? "127.0.0.1",() => console.log(`later.dog supervisor listening on port ${port}. Credentials and state stay in ${dataDir}.`));
const timer = setInterval(() => { void supervisor.tick().catch((error) => console.error(message(error))); },2000);
void supervisor.tick().catch((error) => console.error(message(error)));
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true; clearInterval(timer);
  // A reverse proxy's keep-alive sockets would keep server.close() waiting forever; drop them, and never outlive the host's grace period.
  const deadline = setTimeout(() => { console.error("later.dog supervisor: forcing exit after shutdown timeout"); process.exit(0); }, 10_000); deadline.unref();
  supervisor.stop(); await supervisor.drain();
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  store.close(); clearTimeout(deadline);
}
process.on("SIGINT",() => void shutdown()); process.on("SIGTERM",() => void shutdown());
