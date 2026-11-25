import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ArrowDown, ChevronRight } from "lucide-react";
import { DogAvatar } from "../../src/components/Avatar";
import { applySkin } from "../../src/lib/skins";
import type { DogColor, DogState } from "../../src/lib/mascot";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import { foldSentence } from "../../shared/step-words";
import { BUSY_TURN, SLOT, busyTimeline, roomFor, turnStates, type FoldForm, type Group, type SlotLine, type TurnState } from "./wait-and-landing-model";
import "../../src/styles.css";
import "./wait-and-landing-preview.css";

type Platform = "mac" | "phone";

interface Dog { name: string; color: DogColor; body: MascotBodyId }

const SCOUT: Dog = { name: "Scout", color: "yellow", body: "dog" };
const PEBBLE: Dog = { name: "Pebble", color: "blue", body: "beagle" };
const THISTLE: Dog = { name: "Thistle", color: "purple", body: "corgi" };
const DOGS: Record<string, Dog> = { Scout: SCOUT, Pebble: PEBBLE, Thistle: THISTLE };

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "grid";
const platform: Platform = params.get("platform") === "phone" ? "phone" : "mac";
applySkin(params.get("skin") === "midnight" ? "midnight" : "daylight");
if (params.get("reduced") === "1") document.documentElement.dataset.reducedMotion = "true";

interface PageState { landed: boolean; at: number }
let page: PageState = { landed: params.get("landed") === "1", at: Number(params.get("at") ?? 0) };
const listeners = new Set<() => void>();
const setPage = (patch: Partial<PageState>) => {
  page = { ...page, ...patch };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const usePage = () => useSyncExternalStore(subscribe, () => page);

declare global {
  interface Window { __wl: { land(): void; at(ms: number): void; ready: boolean } }
}
window.__wl = { land: () => setPage({ landed: true }), at: (ms: number) => setPage({ at: ms }), ready: false };

const FOLD: FoldForm = { words: foldSentence({ edit: 1, command: 1 })!, spoken: "Scout finished." };
const PROMPT = params.get("prompt") ?? BUSY_TURN.prompt;
const GREETING = params.get("greeting") ?? "Hi, I'm Scout. What would you like me to do?";
const REPLY_PARTS = [
  "Done. The order form works again.",
  "The spring menu still listed last season's soup, so the form turned down the new price. I updated the menu and placed a test order, and it went through.",
  "Should I put the new menu on the printed flyer too?",
];
const LONG_REPLY = [
  "Done. The order form works again, and here is what was wrong.",
  "The spring menu still listed last season's soup. The order form checks each price against the menu, so every order with the new soup was turned down before it reached you.",
  "I changed three things:\n• the soup's name and price on the spring menu\n• the note customers see when a price has changed\n• the test order the form runs each morning",
  "Then I placed a test order with two soups and a pie. It went through, the receipt shows the new price, and the kitchen copy arrived.",
  "One thing to know: two orders from this morning were turned down. Their emails are in the orders folder if you want to reach out.",
  "Should I put the new menu on the printed flyer too?",
];

interface Row { id: string; side: "user" | "dog"; text: string; dog?: Dog }

const EARLIER: Row[] = [
  { id: "e1", side: "dog", text: "Morning! The spring menu is up on the website." },
  { id: "e2", side: "user", text: "Lovely. A few people say they can't order though." },
  { id: "e3", side: "dog", text: "I can look into it whenever you like." },
  { id: "prompt", side: "user", text: PROMPT },
];

function useSwap(line: SlotLine | null): { current: SlotLine | null; previous: SlotLine | null; count: number } {
  const ref = useRef({ current: line, previous: null as SlotLine | null, count: 0 });
  if (ref.current.current?.key !== line?.key) ref.current = { current: line, previous: ref.current.current, count: ref.current.count + 1 };
  else if (ref.current.current !== line) ref.current = { ...ref.current, current: line };
  return ref.current;
}

function Face({ dog, state, size, still = false }: { dog: Dog; state: DogState; size: number; still?: boolean }) {
  return (
    <span className="wl-face" aria-hidden="true">
      <DogAvatar color={dog.color} bodyId={dog.body} state={state} size={size} trackPointer={false} animated={!still} />
    </span>
  );
}

function Words({ line, old = false, swapped = false }: { line: SlotLine; old?: boolean; swapped?: boolean }) {
  return (
    <span className="wl-text" data-old={old ? "" : undefined} data-swapped={swapped ? "" : undefined} aria-hidden={old ? true : undefined}>
      <span className="wl-phrase">{line.words}</span>
      {line.age && <span className="wl-extra">{` · ${line.age}`}</span>}
      {line.sideJobs && <span className="wl-extra">{` · ${line.sideJobs}`}</span>}
    </span>
  );
}

function Slot({ where, line, fold = null, landed = false, dog, guide = false }: { where: Platform; line: SlotLine | null; fold?: FoldForm | null; landed?: boolean; dog: Dog; guide?: boolean }) {
  const swap = useSwap(line);
  const current = swap.current;
  return (
    <div className="wl-slot" data-platform={where} data-turn-slot={where} data-guide={guide ? "" : undefined} data-row="slot">
      {current && (
        <button type="button" className="wl-line" data-tone={current.tone} data-leaving={landed ? "" : undefined} aria-label={current.spoken}>
          <Face dog={dog} state={current.face} size={SLOT[where].face} still={landed} />
          <span className="wl-words">
            {swap.previous && !landed && <Words key={`old-${swap.count}`} line={swap.previous} old />}
            <Words key={`new-${swap.count}`} line={current} swapped={swap.previous !== null} />
          </span>
        </button>
      )}
      {landed && fold && (
        <button type="button" className="wl-fold" aria-label={fold.spoken} data-still={line === null && guide ? "" : undefined}>
          <span className="wl-fold-words">{fold.words}</span>
          <ChevronRight size={where === "mac" ? 12 : 14} aria-hidden="true" className="wl-fold-chevron" />
        </button>
      )}
    </div>
  );
}

function Bubble({ where, row, joinAbove = false, joinBelow = false, label }: { where: Platform; row: Row; joinAbove?: boolean; joinBelow?: boolean; label?: string }) {
  const user = row.side === "user";
  const corners = user ? `${joinAbove ? "rounded-tr-[8px]" : ""} ${joinBelow ? "rounded-br-[8px]" : ""}` : `${joinAbove ? "rounded-tl-[8px]" : ""} ${joinBelow ? "rounded-bl-[8px]" : ""}`;
  const size = where === "mac" ? "max-w-[min(42rem,78%)] rounded-[20px] text-[16px] leading-6" : "max-w-[86%] rounded-[18px] text-[17px] leading-6";
  const tone = user ? "bg-bubble-user px-[14px] py-2 whitespace-pre-wrap text-white" : "bg-[var(--color-bubble,var(--color-card))] px-[14px] py-2 text-ink";
  return (
    <div data-from={user ? "user" : "agent"} data-row={row.id} className={`flex w-full ${user ? "justify-end" : "justify-start"}`}>
      <div className={`chat-bubble relative w-fit ${size} ${tone} ${corners}`}>
        {label && <div className="text-[13px] leading-[17px] font-medium text-ink-secondary">{label}</div>}
        {row.text.split("\n\n").map((part, index) => <p key={index} className="mb-3 whitespace-pre-line last:mb-0">{part}</p>)}
      </div>
    </div>
  );
}

function rowsWithJoins(where: Platform, rows: readonly Row[], labels = false): ReactNode[] {
  return rows.map((row, index) => (
    <Bubble
      key={row.id}
      where={where}
      row={row}
      joinAbove={rows[index - 1]?.side === row.side && rows[index - 1]?.dog === row.dog}
      joinBelow={rows[index + 1]?.side === row.side && rows[index + 1]?.dog === row.dog}
      label={labels && row.dog && rows[index - 1]?.dog !== row.dog ? row.dog.name : undefined}
    />
  ));
}

interface Turn {
  dog: Dog;
  line: SlotLine | null;
  fold: FoldForm | null;
  replies: Row[];
  landed: boolean;
  labels?: boolean;
}

function Transcript({ where, rows, turn, scrolledUp = 0, asksAway = null }: { where: Platform; rows: Row[]; turn: Turn; scrolledUp?: number; asksAway?: string | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const [below, setBelow] = useState<"none" | "latest" | "new">("none");
  useLayoutEffect(() => {
    const element = scroller.current!;
    setRoom(roomFor(element.clientHeight, SLOT[where].height));
  }, [where]);
  useLayoutEffect(() => {
    if (!room) return;
    const element = scroller.current!;
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - scrolledUp);
    window.__wl.ready = true;
  }, [room, scrolledUp]);
  useLayoutEffect(() => {
    const element = scroller.current!;
    const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
    setBelow(atBottom ? "none" : turn.landed && scrolledUp > 0 ? "new" : "latest");
  }, [turn.landed, room, scrolledUp]);
  const slotShown = !turn.landed || turn.fold !== null;
  const replies = turn.landed ? turn.replies : [];
  const column = where === "mac" ? "wl-column" : "wl-phone-column";
  const pillBottom = where === "mac" ? 92 : 104;
  return (
    <>
      <div className="wl-scroller" ref={scroller} data-scroller={where}>
        <div className={column}>
          {rowsWithJoins(where, rows)}
          <div className="wl-turn" data-turn-block="" style={{ minHeight: room ? SLOT[where].height + room : undefined }}>
            {slotShown && <Slot where={where} line={turn.line} fold={turn.fold} landed={turn.landed} dog={turn.dog} />}
            {rowsWithJoins(where, replies, turn.labels).map((node, index) => (
              <div key={replies[index]!.id} className="contents" data-arriving="" style={{ "--wl-delay": `${Math.min(index, 3) * 50}ms` } as CSSProperties}>
                {node}
              </div>
            ))}
          </div>
        </div>
      </div>
      {asksAway && <div className="wl-jump" data-tone="asks" style={{ bottom: pillBottom }}>{asksAway} <ArrowDown size={13} /></div>}
      {!asksAway && below !== "none" && <div className="wl-jump" data-jump={below} style={{ bottom: pillBottom }}><ArrowDown size={13} /> {below === "new" ? "1 new reply" : "Jump to latest"}</div>}
    </>
  );
}

function Sidebar({ scout }: { scout: { words: string; tone: string; face: DogState } }) {
  const rows: Array<{ dog: Dog; words: string; tone?: string; face: DogState; selected?: boolean; unread?: boolean }> = [
    { dog: SCOUT, words: scout.words, tone: scout.tone, face: scout.face, selected: true },
    { dog: PEBBLE, words: "Sent you the new price list", face: "idle" },
    { dog: THISTLE, words: "Happy to help with the flyer!", face: "idle", unread: true },
  ];
  return (
    <aside className="wl-sidebar" data-sidebar="">
      {rows.map((row) => (
        <div key={row.dog.name} className="wl-side-row" data-selected={row.selected ? "" : undefined}>
          <span className="relative flex shrink-0"><DogAvatar color={row.dog.color} bodyId={row.dog.body} state={row.face} size={32} trackPointer={false} animated={row.face !== "idle"} /></span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="wl-side-name">{row.dog.name}</span>
            <span className="wl-side-line" data-tone={row.tone}>{row.words}</span>
          </span>
          {row.unread && <span className="status-dot size-2.5 shrink-0 rounded-full bg-unread" aria-label="Unread" />}
        </div>
      ))}
    </aside>
  );
}

function MacWindow({ dog, sidebar, children, width = 1100, height = 760 }: { dog: Dog; sidebar?: { words: string; tone: string; face: DogState } | null; children: ReactNode; width?: number; height?: number }) {
  return (
    <main className="wl-window" data-window="mac" style={{ width, height }}>
      {sidebar && <Sidebar scout={sidebar} />}
      <section className="wl-chat">
        <header className="wl-chathead">
          <span className="wl-pill"><DogAvatar color={dog.color} bodyId={dog.body} state="idle" size={24} trackPointer={false} animated={false} />{dog.name}</span>
        </header>
        {children}
        <div className="wl-composer"><div className="wl-composer-box">Message {dog.name}<span className="wl-stop" aria-label="Stop" /></div></div>
      </section>
    </main>
  );
}

function PhoneWindow({ dog, children }: { dog: Dog; children: ReactNode }) {
  return (
    <main className="wl-phone" data-window="phone">
      <div className="wl-phone-status"><span>9:41</span><span className="wl-island" /><span className="text-[13px]">5G ▮</span></div>
      <div className="wl-phone-nav">
        <span className="wl-phone-back" aria-hidden="true">‹</span>
        <span className="wl-pill"><DogAvatar color={dog.color} bodyId={dog.body} state="idle" size={24} trackPointer={false} animated={false} />{dog.name}</span>
      </div>
      <span className="wl-mock-tag">phone mock</span>
      {children}
      <div className="wl-phone-composer"><span className="wl-phone-plus">+</span><span className="wl-phone-field">Message {dog.name}</span></div>
      <div className="wl-phone-home" />
    </main>
  );
}

function Chat({ where, dog, rows, turn, sidebar = null, scrolledUp = 0, asksAway = null }: { where: Platform; dog: Dog; rows: Row[]; turn: Turn; sidebar?: { words: string; tone: string; face: DogState } | null; scrolledUp?: number; asksAway?: string | null }) {
  const transcript = <Transcript where={where} rows={rows} turn={turn} scrolledUp={scrolledUp} asksAway={asksAway} />;
  return where === "mac" ? <MacWindow dog={dog} sidebar={sidebar}>{transcript}</MacWindow> : <PhoneWindow dog={dog}>{transcript}</PhoneWindow>;
}

const ALL_STATES = turnStates();
const stateLine = (id: string) => ALL_STATES.find((state) => state.id === id)!.line;

function GridRow({ state }: { state: TurnState }) {
  const dog = DOGS[state.speaker ?? "Scout"]!;
  const heard = state.line?.spoken ?? state.fold?.spoken;
  const cell = (where: Platform) => {
    if (state.line) return <Slot where={where} line={state.line} dog={dog} guide />;
    if (state.fold) return <Slot where={where} line={null} fold={state.fold} landed dog={dog} guide />;
    return <div className="py-2"><Bubble where={where} row={{ id: `${state.id}-${where}`, side: "dog", text: "Yes, Tuesday works." }} /></div>;
  };
  return (
    <div className="wl-row" data-state={state.id}>
      <div className="wl-label">
        <b>{state.title}</b>
        <span>{state.cause}</span>
        {heard && <i>Heard: “{heard}”</i>}
        {(state.note || state.outcome) && <span>{state.note ?? state.outcome}</span>}
        <code>{state.source}</code>
      </div>
      <div className="wl-mac-cell">{cell("mac")}</div>
      <div className="wl-phone-cell">{cell("phone")}</div>
    </div>
  );
}

const PARTS: Record<string, Group[]> = {
  "1": ["Delivery", "Working"],
  "2": ["Waiting on you", "Waiting on something else", "Ends", "Rooms"],
};

function GridView() {
  const groups = PARTS[params.get("part") ?? ""] ?? [...PARTS["1"]!, ...PARTS["2"]!];
  useEffect(() => { window.__wl.ready = true; }, []);
  return (
    <main className="wl-page wl-grid" data-view="grid">
      <div className="wl-grid-head">
        <div>
          <div className="wl-grid-title">The turn slot, every state</div>
          <div>One line, one height. The dashed box is the space reserved for the turn.</div>
        </div>
        <div>Mac · 672 px chat column · 32 px slot · 24 px face</div>
        <div>Phone mock, not the iPhone app · 393 pt · 44 pt slot · 28 pt face</div>
      </div>
      {groups.map((group) => (
        <section key={group}>
          <div className="wl-group">{group}</div>
          {ALL_STATES.filter((state) => state.group === group).map((state) => <GridRow key={state.id} state={state} />)}
        </section>
      ))}
    </main>
  );
}

function landingTurn(kind: string, landed: boolean): { dog: Dog; turn: Turn; scrolledUp: number; asksAway: string | null } {
  const reply = (id: string, text: string, dog: Dog = SCOUT): Row => ({ id, side: "dog", text, dog });
  const writing = stateLine("writing-back");
  switch (kind) {
    case "plain":
      return { dog: SCOUT, scrolledUp: 0, asksAway: null, turn: { dog: SCOUT, line: stepLineOf("thinking"), fold: null, replies: [reply("r1", REPLY_PARTS[0]!)], landed } };
    case "long":
      return { dog: SCOUT, scrolledUp: 0, asksAway: null, turn: { dog: SCOUT, line: writing, fold: FOLD, replies: [reply("r1", LONG_REPLY.join("\n\n"))], landed } };
    case "reading":
      return { dog: SCOUT, scrolledUp: 320, asksAway: null, turn: { dog: SCOUT, line: writing, fold: FOLD, replies: [reply("r1", REPLY_PARTS.join("\n\n"))], landed } };
    case "batch":
      return { dog: PEBBLE, scrolledUp: 0, asksAway: null, turn: { dog: PEBBLE, line: stateLine("room-many"), fold: null, labels: true, replies: [reply("r1", "The flyer can take the new menu by Friday.", PEBBLE), reply("r2", "And I can bring a draft over tomorrow morning.", PEBBLE), reply("r3", "I'll proofread it once it's in.", THISTLE)], landed } };
    case "split":
      return { dog: SCOUT, scrolledUp: 0, asksAway: null, turn: { dog: SCOUT, line: writing, fold: FOLD, replies: REPLY_PARTS.map((text, index) => reply(`r${index + 1}`, text)), landed } };
    case "asks-away":
      return { dog: SCOUT, scrolledUp: 300, asksAway: "Waiting for your OK", turn: { dog: SCOUT, line: stateLine("needs-ok"), fold: null, replies: [], landed: false } };
    default:
      return { dog: SCOUT, scrolledUp: 0, asksAway: null, turn: { dog: SCOUT, line: writing, fold: FOLD, replies: [reply("r1", REPLY_PARTS.join("\n\n"))], landed } };
  }
}

function stepLineOf(id: string): SlotLine {
  return stateLine(id)!;
}

function LandingView() {
  const { landed } = usePage();
  const kind = params.get("case") ?? "fold";
  const { dog, turn, scrolledUp, asksAway } = landingTurn(kind, landed);
  const rows: Row[] = kind === "batch" ? [...EARLIER.slice(0, 3), { id: "prompt", side: "user", text: "Can someone get the new menu onto the flyer?" }] : EARLIER;
  return <div className="wl-page p-6" data-view="landing"><Chat where={platform} dog={dog} rows={rows} turn={turn} scrolledUp={scrolledUp} asksAway={asksAway} /></div>;
}

function BusyView() {
  const { at } = usePage();
  const frames = useMemo(() => busyTimeline(BUSY_TURN.landsAt), []);
  const landed = at >= BUSY_TURN.landsAt;
  let shown: SlotLine | null = null;
  for (const frame of frames) if (frame.at <= Math.min(at, BUSY_TURN.landsAt - 1)) shown = frame.shown;
  const rows: Row[] = [{ id: "greeting", side: "dog", text: GREETING }, { id: "prompt", side: "user", text: PROMPT }];
  const turn: Turn = { dog: SCOUT, line: shown, fold: landed ? FOLD : null, replies: [{ id: "reply", side: "dog", text: params.get("reply") ?? BUSY_TURN.reply, dog: SCOUT }], landed };
  const sidebar = landed ? { words: params.get("reply") ?? BUSY_TURN.reply, tone: "plain", face: "idle" as DogState } : shown ? { words: shown.words, tone: shown.tone, face: shown.face } : { words: PROMPT, tone: "plain", face: "idle" as DogState };
  useEffect(() => { window.__wl.ready = true; }, []);
  return <div className="wl-page p-6" data-view="busy"><Chat where={platform} dog={SCOUT} rows={rows} turn={turn} sidebar={platform === "mac" ? sidebar : null} /></div>;
}

function BubblesView() {
  const reply = (id: string, text: string): Row => ({ id, side: "dog", text, dog: SCOUT });
  const single: Turn = { dog: SCOUT, line: null, fold: FOLD, replies: [reply("r1", REPLY_PARTS.join("\n\n"))], landed: true };
  const split: Turn = { dog: SCOUT, line: null, fold: FOLD, replies: REPLY_PARTS.map((text, index) => reply(`r${index + 1}`, text)), landed: true };
  useEffect(() => { window.__wl.ready = true; }, []);
  const column = (title: string, turn: Turn) => (
    <div className="flex flex-col gap-3">
      <div className="wl-caption"><b>{title}</b></div>
      <Chat where={platform} dog={SCOUT} rows={EARLIER.slice(2)} turn={turn} />
    </div>
  );
  return (
    <div className="wl-page flex gap-10 p-8" data-view="bubbles">
      {column("One bubble", single)}
      {column("Separate bubbles", split)}
    </div>
  );
}

const MOMENTS: Array<[string, string]> = [["sent", "Just sent"], ["working", "A few seconds in"], ["minute", "A minute in"], ["landed", "The reply lands"]];

function CompareView() {
  const base = "/docs/verification/assets/wait-and-landing";
  const [loaded, setLoaded] = useState(0);
  useEffect(() => { if (loaded >= MOMENTS.length * 2) window.__wl.ready = true; }, [loaded]);
  return (
    <main className="wl-page wl-compare" data-view="compare">
      <div />
      <div className="wl-caption"><b>Today</b> · the real app on a fake-engine fixture</div>
      <div className="wl-caption"><b>Proposed</b> · the prototype, same turn</div>
      {MOMENTS.map(([id, title]) => (
        <Fragment key={id}>
          <div className="wl-caption"><b>{title}</b></div>
          <img alt={`Today: ${title}`} src={`${base}/before-${id}.png`} onLoad={() => setLoaded((count) => count + 1)} />
          <img alt={`Proposed: ${title}`} src={`${base}/after-${id}.png`} onLoad={() => setLoaded((count) => count + 1)} />
        </Fragment>
      ))}
    </main>
  );
}

function Root() {
  if (view === "landing") return <LandingView />;
  if (view === "busy") return <BusyView />;
  if (view === "bubbles") return <BubblesView />;
  if (view === "compare") return <CompareView />;
  return <GridView />;
}

createRoot(document.getElementById("root")!).render(<Root />);
