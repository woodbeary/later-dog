import { isAmbientLaterDogKey } from "./laterdog-env.ts";

for (const key of Object.keys(process.env)) {
  if (isAmbientLaterDogKey(key)) delete process.env[key];
}
