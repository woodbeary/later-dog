import type { Refusal } from "./auth";
import { apiError, json } from "./http";
import type { PersonalBox } from "./box";
import type { ComputerView } from "./computer";
import { inventoryRow, moveProfile, type MovableComputer } from "./box-migrate";

export const BOX_DESKTOPS = 6;
const DOG = /^[\w-]{1,64}$/;
export const validDog = (dog: string): boolean => DOG.test(dog);
export const profileKey = (person: string, dog: string): string => `box/${person}/profiles/${dog}.tgz`;

const NO_BOX: Refusal = { status: 403, code: "box_not_in_trial", message: "The personal box comes with later.dog Cloud, not the free trial." };
const NOT_STARTED: Refusal = { status: 503, code: "box_starting", message: "The personal box is starting; try again in a few seconds." };
const NO_PROFILE: Refusal = { status: 404, code: "no_profile", message: "This dog has no profile on the box to save." };
const BAD_DOG: Refusal = { status: 400, code: "invalid_dog", message: "A dog id has 1 to 64 letters, digits, dashes or underscores." };
const MOVE_PATH = /^\/v1\/box\/moves\/([^/]+)\/from\/([^/]+)$/;
const COMPUTER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NOT_YOURS: Refusal = { status: 404, code: "computer_not_found", message: "No such computer." };
const DESKTOP_PATH = /^\/v1\/box\/desktops\/([^/]+)(\/screenshot|\/viewer|\/input|\/save)?$/;

export type BoxRoute =
  | { op: "view" | "start" | "stop" | "profiles" | "inventory" }
  | { op: "move"; dog: string; computer: string }
  | { op: "open" | "close" | "screenshot" | "viewer" | "input" | "save"; dog: string }
  | { op: "method_not_allowed"; allow: string[] };

export function boxRoute(method: string, pathname: string): BoxRoute | undefined {
  if (pathname === "/v1/box") {
    const op = ({ GET: "view", POST: "start", DELETE: "stop" } as const)[method as "GET" | "POST" | "DELETE"];
    return op ? { op } : { op: "method_not_allowed", allow: ["GET", "POST", "DELETE"] };
  }
  if (pathname === "/v1/box/moves") return method === "GET" ? { op: "inventory" } : { op: "method_not_allowed", allow: ["GET"] };
  const move = MOVE_PATH.exec(pathname);
  if (move) return method === "POST" ? { op: "move", dog: decodeURIComponent(move[1]!), computer: decodeURIComponent(move[2]!) } : { op: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/box/profiles") return method === "GET" ? { op: "profiles" } : { op: "method_not_allowed", allow: ["GET"] };
  const match = DESKTOP_PATH.exec(pathname);
  if (!match) return undefined;
  const dog = decodeURIComponent(match[1]!);
  if (match[2] === "/screenshot") return method === "GET" ? { op: "screenshot", dog } : { op: "method_not_allowed", allow: ["GET"] };
  if (match[2] === "/save") return method === "POST" ? { op: "save", dog } : { op: "method_not_allowed", allow: ["POST"] };
  if (match[2] === "/input") return method === "POST" ? { op: "input", dog } : { op: "method_not_allowed", allow: ["POST"] };
  if (match[2] === "/viewer") return method === "GET" ? { op: "viewer", dog } : { op: "method_not_allowed", allow: ["GET"] };
  if (method === "POST") return { op: "open", dog };
  if (method === "DELETE") return { op: "close", dog };
  return { op: "method_not_allowed", allow: ["POST", "DELETE"] };
}

export function personalBox(namespace: DurableObjectNamespace<PersonalBox>, person: string): DurableObjectStub<PersonalBox> {
  return namespace.get(namespace.idFromName(`box:${person}`));
}

export interface BoxOwner {
  person: string;
  trial: boolean;
  computers(): Promise<ComputerView[]>;
  computer(id: string): MovableComputer;
}

export interface BoxPlace {
  boxes: DurableObjectNamespace<PersonalBox>;
  state: R2Bucket;
}

export async function boxRequest(route: BoxRoute, request: Request, place: BoxPlace, owner: BoxOwner): Promise<Response> {
  const { person } = owner;
  const namespace = place.boxes;
  if (owner.trial) return apiError(NO_BOX);
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
    case "inventory": {
      const saved = new Map((await box.saved().catch(() => [])).map((profile) => [profile.dog, profile]));
      const computers = await owner.computers();
      return json({ computers: computers.map((view) => inventoryRow(view, null)), packaged: [...saved.values()] });
    }
    case "move": {
      if (!COMPUTER_ID.test(route.computer)) return apiError(NOT_YOURS);
      if (!(await owner.computers()).some((view) => view.id === route.computer)) return apiError(NOT_YOURS);
      const moved = await moveProfile({ computer: owner.computer(route.computer), computerId: route.computer, dog: route.dog, person, bucket: place.state });
      return moved.ok ? json({ moved }) : json({ error: { code: moved.code, message: moved.message } }, moved.status);
    }
    case "profiles":
      return json({ profiles: await box.saved() });
    case "save": {
      const saved = await box.save(route.dog);
      return saved ? json({ saved }) : apiError(NO_PROFILE);
    }
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
    case "input": {
      let body: unknown;
      try { body = JSON.parse(await request.text()); } catch { return json({ error: { code: "invalid_json", message: "The body is not valid JSON." } }, 400); }
      const done = await box.input(route.dog, body);
      return done ? json(done.body, done.status) : apiError(NOT_STARTED);
    }
    case "viewer": {
      const url = new URL("https://box/viewer");
      url.searchParams.set("dog", route.dog);
      return box.fetch(new Request(url, { headers: request.headers }));
    }
  }
}
