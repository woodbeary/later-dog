import type { Refusal } from "./auth";
import { apiError, json } from "./http";
import type { PersonalBox } from "./box";

export const BOX_DESKTOPS = 6;
const DOG = /^[\w-]{1,64}$/;
export const validDog = (dog: string): boolean => DOG.test(dog);

const NO_BOX: Refusal = { status: 403, code: "box_not_in_trial", message: "The personal box comes with later.dog Cloud, not the free trial." };
const NOT_STARTED: Refusal = { status: 503, code: "box_starting", message: "The personal box is starting; try again in a few seconds." };
const BAD_DOG: Refusal = { status: 400, code: "invalid_dog", message: "A dog id has 1 to 64 letters, digits, dashes or underscores." };
const DESKTOP_PATH = /^\/v1\/box\/desktops\/([^/]+)(\/screenshot|\/viewer)?$/;

export type BoxRoute =
  | { op: "view" | "start" | "stop" }
  | { op: "open" | "close" | "screenshot" | "viewer"; dog: string }
  | { op: "method_not_allowed"; allow: string[] };

export function boxRoute(method: string, pathname: string): BoxRoute | undefined {
  if (pathname === "/v1/box") {
    const op = ({ GET: "view", POST: "start", DELETE: "stop" } as const)[method as "GET" | "POST" | "DELETE"];
    return op ? { op } : { op: "method_not_allowed", allow: ["GET", "POST", "DELETE"] };
  }
  const match = DESKTOP_PATH.exec(pathname);
  if (!match) return undefined;
  const dog = decodeURIComponent(match[1]!);
  if (match[2] === "/screenshot") return method === "GET" ? { op: "screenshot", dog } : { op: "method_not_allowed", allow: ["GET"] };
  if (match[2] === "/viewer") return method === "GET" ? { op: "viewer", dog } : { op: "method_not_allowed", allow: ["GET"] };
  if (method === "POST") return { op: "open", dog };
  if (method === "DELETE") return { op: "close", dog };
  return { op: "method_not_allowed", allow: ["POST", "DELETE"] };
}

export function personalBox(namespace: DurableObjectNamespace<PersonalBox>, person: string): DurableObjectStub<PersonalBox> {
  return namespace.get(namespace.idFromName(`box:${person}`));
}

export async function boxRequest(route: BoxRoute, request: Request, namespace: DurableObjectNamespace<PersonalBox>, person: string, trial: boolean): Promise<Response> {
  if (trial) return apiError(NO_BOX);
  if (route.op === "method_not_allowed") return json({ error: { code: "method_not_allowed", message: "Method not allowed." } }, 405, { allow: route.allow.join(", ") });
  if ("dog" in route && !validDog(route.dog)) return apiError(BAD_DOG);
  const box = personalBox(namespace, person);
  switch (route.op) {
    case "view":
      return json({ box: (await box.status()) ?? null, maxDesktops: BOX_DESKTOPS });
    case "start":
      return json({ box: await box.ensure(person) }, 202);
    case "stop":
      await box.stop();
      return json({ stopped: true });
    case "open": {
      await box.ensure(person);
      const opened = await box.open(route.dog);
      return opened ? json(opened.body, opened.status) : apiError(NOT_STARTED);
    }
    case "close": {
      const closed = await box.close(route.dog);
      return closed ? json(closed.body, closed.status) : apiError(NOT_STARTED);
    }
    case "screenshot": {
      const shot = await box.screenshot(route.dog);
      if (!shot) return apiError(NOT_STARTED);
      if (shot.png) return new Response(shot.png, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
      return json(shot.body, shot.status);
    }
    case "viewer": {
      const url = new URL("https://box/viewer");
      url.searchParams.set("dog", route.dog);
      return box.fetch(new Request(url, { headers: request.headers }));
    }
  }
}
