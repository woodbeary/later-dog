import { guardianArguments, runManagedCompanionGuardian } from "./managed-companion-guardian.mjs";

runManagedCompanionGuardian(guardianArguments(process.argv.slice(2))).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
