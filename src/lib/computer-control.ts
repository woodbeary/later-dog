export type ComputerControlAction = "take" | "release" | "dismiss-help";

export interface ComputerControlSnapshot {
  held: boolean;
  helpReason: string | null;
}

export type BrowserControlTransitionFailure =
  | "native-take"
  | "durable-take"
  | "durable-release"
  | "native-release";

export async function transitionBrowserControlLease(input: {
  action: "take" | "release";
  requestDurableControl: (action: "take" | "release") => Promise<boolean>;
  setNativeControl: (held: boolean) => Promise<boolean>;
}): Promise<{ ok: true } | { ok: false; failed: BrowserControlTransitionFailure }> {
  const { action, requestDurableControl, setNativeControl } = input;
  if (action === "take") {
    if (!(await setNativeControl(true))) return { ok: false, failed: "native-take" };
    if (!(await requestDurableControl("take"))) return { ok: false, failed: "durable-take" };
    return { ok: true };
  }

  if (!(await requestDurableControl("release"))) {
    await setNativeControl(true);
    return { ok: false, failed: "durable-release" };
  }
  if (!(await setNativeControl(false))) return { ok: false, failed: "native-release" };
  return { ok: true };
}

export function heldComputerControlBotIds(
  snapshots: Record<string, Pick<ComputerControlSnapshot, "held">>,
): string[] {
  return Object.entries(snapshots)
    .filter(([, snapshot]) => snapshot.held)
    .map(([botId]) => botId);
}

export async function transitionComputerControlLease<
  Action extends ComputerControlAction,
  Snapshot extends ComputerControlSnapshot,
>(input: {
  action: Action;
  syncNativeBrowser: boolean;
  requestControl: (action: Action) => Promise<Snapshot>;
  setNativeBrowserControl: (held: boolean) => Promise<boolean>;
}): Promise<Snapshot> {
  const { action, syncNativeBrowser, requestControl, setNativeBrowserControl } = input;
  if (action === "dismiss-help") return requestControl(action);
  if (action === "take" && syncNativeBrowser && !(await setNativeBrowserControl(true))) {
    throw new Error("later.dog could not pause this dog's browser safely");
  }
  const snap = await requestControl(action);
  if (snap.held !== (action === "take")) {
    throw new Error(`later.dog could not ${action === "take" ? "confirm" : "release"} computer control`);
  }
  if (action === "release" && syncNativeBrowser && !(await setNativeBrowserControl(false))) {
    throw new Error("The computer was released, but the browser remains paused for safety");
  }
  return snap;
}
