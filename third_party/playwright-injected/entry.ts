import { generateAriaTree, renderAriaTreeAsJSON, type AriaSnapshot } from "./src/ariaSnapshot";
import { renderAriaSnapshotAsYaml } from "./isomorphic/ariaSnapshotRenderer";

const VERSION = 1;
const DEFAULT_MAX_CHARS = 60_000;

let last: AriaSnapshot | null = null;
let lastIntegrity = new Map<string, string>();

type SnapshotResult = {
  version: number;
  yaml: string;
  refs: string[];
  truncated: boolean;
  iframes: number;
};

type BoxResult =
  | { found: false }
  | { found: true; connected: false }
  | { found: true; connected: true; visible: boolean; x: number; y: number; width: number; height: number };

function nodesByRef(root: AriaSnapshot["root"]): Map<string, AriaSnapshot["root"]> {
  const byRef = new Map<string, AriaSnapshot["root"]>();
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.ref)
      byRef.set(node.ref, node);
    for (const child of node.children) {
      if (typeof child !== "string")
        pending.push(child);
    }
  }
  return byRef;
}

function integritySignature(node: AriaSnapshot["root"], element: Element): string {
  const attributes = Array.from(element.attributes)
    .map(attribute => [attribute.name, attribute.value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const properties = Object.entries(node.props)
    .sort(([left], [right]) => left.localeCompare(right));
  const control = element as Element & {
    disabled?: boolean;
    readOnly?: boolean;
    tabIndex?: number;
    isContentEditable?: boolean;
  };
  return JSON.stringify({
    role: node.role,
    name: node.name,
    properties,
    tag: element.tagName,
    attributes,
    disabled: control.disabled === true,
    readOnly: control.readOnly === true,
    tabIndex: Number.isInteger(control.tabIndex) ? control.tabIndex : null,
    contentEditable: control.isContentEditable === true,
    visible: node.box.visible,
    receivesPointerEvents: node.receivesPointerEvents,
  });
}

function recordIntegrity(tree: AriaSnapshot): Map<string, string> {
  const result = new Map<string, string>();
  const nodes = nodesByRef(tree.root);
  for (const [ref, info] of tree.info) {
    const node = nodes.get(ref);
    if (node)
      result.set(ref, integritySignature(node, info.element));
  }
  return result;
}

function snapshot(maxChars: number = DEFAULT_MAX_CHARS): SnapshotResult {
  const root = document.body ?? document.documentElement;
  const tree = generateAriaTree(root, { mode: "ai" });
  last = tree;
  lastIntegrity = recordIntegrity(tree);
  const { json } = renderAriaTreeAsJSON(tree, { mode: "ai" });
  let yaml = renderAriaSnapshotAsYaml(json);
  let truncated = false;
  if (yaml.length > maxChars) {
    yaml = `${yaml.slice(0, maxChars)}\n…(snapshot truncated at ${maxChars} characters — the start of the page in document order, not the visible part. Scrolling does not reveal the rest; work from a narrower page.)`;
    truncated = true;
  }
  return { version: VERSION, yaml, refs: [...tree.info.keys()], truncated, iframes: tree.iframeRefs.length };
}

function elementForRef(ref: string): Element | null {
  return last?.info.get(ref)?.element ?? null;
}

function validateRef(ref: string): boolean {
  const element = elementForRef(ref);
  const reviewed = lastIntegrity.get(ref);
  const root = document.body ?? document.documentElement;
  if (!element || !reviewed || !root || !element.isConnected)
    return false;
  const current = generateAriaTree(root, { mode: "ai" });
  const currentRef = current.refs.get(element);
  if (currentRef !== ref)
    return false;
  const currentNode = nodesByRef(current.root).get(currentRef);
  return currentNode ? integritySignature(currentNode, element) === reviewed : false;
}

function composedContains(ancestor: Node, candidate: Node | null): boolean {
  for (let current = candidate; current;) {
    if (current === ancestor)
      return true;
    const root = current.getRootNode();
    current = current.parentNode ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

function deepestElementAtPoint(x: number, y: number): Element | null {
  let hit = document.elementFromPoint(x, y);
  for (let depth = 0; hit && depth < 16; depth += 1) {
    const inner = hit.shadowRoot?.elementFromPoint(x, y);
    if (!inner || inner === hit)
      break;
    hit = inner;
  }
  return hit;
}

function hitTestRef(ref: string, x: number, y: number): boolean {
  const element = elementForRef(ref);
  const hit = deepestElementAtPoint(x, y);
  if (!element || !hit || !element.isConnected)
    return false;
  return composedContains(element, hit) || composedContains(hit, element);
}

const nextFrames = (count: number, maxMs = 150): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    const tick = (left: number) => (left <= 0 ? finish() : requestAnimationFrame(() => tick(left - 1)));
    tick(count);
    setTimeout(finish, maxMs);
  });

async function boxForRef(ref: string): Promise<BoxResult> {
  const element = elementForRef(ref);
  if (!element) return { found: false };
  if (!element.isConnected) return { found: true, connected: false };
  try {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  } catch {}
  await nextFrames(2);
  const rect = element.getBoundingClientRect();
  const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  return {
    found: true,
    connected: true,
    visible,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
  };
}

function focusRef(ref: string): boolean {
  const element = elementForRef(ref);
  if (!element) return false;
  const focusable = element as HTMLElement & { focus?: () => void };
  if (focusable.focus) focusable.focus();
  return document.activeElement === element || element.contains(document.activeElement);
}

declare global {
  interface Window {
    __laterdogBrowser?: {
      version: number;
      snapshot: typeof snapshot;
      elementForRef: typeof elementForRef;
      validateRef: typeof validateRef;
      hitTestRef: typeof hitTestRef;
      boxForRef: typeof boxForRef;
      focusRef: typeof focusRef;
    };
  }
}

window.__laterdogBrowser = { version: VERSION, snapshot, elementForRef, validateRef, hitTestRef, boxForRef, focusRef };
