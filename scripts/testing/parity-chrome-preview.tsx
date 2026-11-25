import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Copy, MessageCircle, Moon, Pencil, Settings, Trash2, Users } from "lucide-react";
import { BotListItem, botRowProps } from "../../src/components/Sidebar";
import { SidebarPopoverMenu } from "../../src/components/SidebarPopoverMenu";
import { ChatHeaderMenu } from "../../src/components/ChatHeaderTasks";
import { MessageActions } from "../../src/components/MessageActions";
import { StoreChannelContext, type StoreChannel } from "../../src/state/store-channel";
import { initialState, type Bot } from "../../src/state/store";
import { applySkin, SKIN_IDS, type SkinId } from "../../src/lib/skins";
import { stepPhrase } from "../../shared/step-words";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const skin = params.get("skin");
applySkin(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "daylight");

const now = Date.now();
const tryingId = Array.from({ length: 64 }, (_, index) => `run-${index}:tool-1`).find(
  (id) => stepPhrase("running", id) === "Trying it out",
)!;

const dog = (
  id: string,
  name: string,
  color: string,
  patch: Partial<Bot> & { step?: unknown } = {},
): Bot =>
  ({
    id,
    threadId: `thread-${id}`,
    name,
    title: "",
    description: "",
    notifications: true,
    color,
    unread: false,
    modelSelection: { instanceId: "preview", model: "preview" },
    messages: [],
    ...patch,
  }) as Bot;

const said = (id: string, text: string, minutesAgo: number) => ({
  id,
  role: "bot",
  text,
  at: now - minutesAgo * 60_000,
});

const dogs: Bot[] = [
  dog("juniper", "Juniper", "green", {
    busy: true,
    activity: "working",
    step: { id: tryingId, kind: "running", startedAt: now - 40_000, lastActivityAt: now - 2_000 },
    messages: [said("j1", "On it.", 1)] as Bot["messages"],
  }),
  dog("mabel", "Mabel", "purple", {
    waitingForTeammates: true,
    waitingOn: [{ botId: "otis", name: "Otis", state: "needsYou" }],
    messages: [said("m1", "Otis is checking the bookings.", 6)] as Bot["messages"],
  }),
  dog("otis", "Otis", "orange", {
    busy: true,
    activity: "waiting-on-you",
    messages: [
      {
        id: "o1",
        role: "bot",
        kind: "options",
        at: now - 3 * 60_000,
        card: {
          title: "A question",
          subtitle: "",
          options: [],
          requestType: "question",
          questionRequest: {
            version: 1,
            questions: [
              {
                question:
                  "Should I move Friday's dinner to Saturday at seven, or keep Friday and ask for a later table?",
                options: [{ label: "Saturday at seven" }, { label: "Keep Friday" }],
              },
            ],
          },
        },
      },
    ] as Bot["messages"],
  }),
  dog("clove", "Clove", "blue", {
    unread: true,
    messages: [said("c1", "Your trip notes are ready to read.", 22)] as Bot["messages"],
  }),
  dog("biscuit", "Biscuit", "yellow", {
    messages: [said("b1", "All set for tomorrow.", 180)] as Bot["messages"],
  }),
];

const state = { ...initialState, selectedId: "juniper", bots: dogs };
const noop = () => {};

function Rows({ density }: { density: "comfortable" | "icons" }) {
  return (
    <div
      className={
        density === "icons"
          ? "flex flex-col items-center gap-1 px-2 pt-3.5"
          : "flex flex-col gap-0.5 px-2 pt-3"
      }
    >
      {dogs.map((bot) => (
        <BotListItem key={bot.id} {...botRowProps(state, noop, bot, { density, onMenu: noop })} />
      ))}
    </div>
  );
}

function OpenMenu() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click();
  }, []);
  return (
    <div ref={ref} className="ml-16 w-[236px]">
      <SidebarPopoverMenu
        ariaLabel="Menu"
        placement="below"
        renderTrigger={() => (
          <span className="block rounded-lg px-3 py-2 text-left text-[14px] text-ink">Juniper</span>
        )}
        items={[
          {
            key: "chat",
            heading: "Juniper",
            label: "New chat",
            icon: <MessageCircle size={16} />,
            onSelect: noop,
          },
          {
            key: "team",
            label: "Add to a group",
            subtitle: "In 2 groups",
            note: "Everyone in a group can read its chat",
            icon: <Users size={16} />,
            onSelect: noop,
          },
          {
            key: "quiet",
            label: "Quiet for an hour",
            icon: <Moon size={16} />,
            active: true,
            onSelect: noop,
          },
          {
            key: "settings",
            label: "Settings",
            icon: <Settings size={16} />,
            separatorBefore: true,
            onSelect: noop,
          },
        ]}
      />
    </div>
  );
}

const opener = { botId: "juniper", name: "Juniper", at: now - 600_000 };
const juniperWithTasks = {
  ...dogs[0]!,
  tasks: [
    {
      threadId: "flights",
      title: "Book flights",
      createdAt: now - 300_000,
      openedBy: opener,
      busy: true,
    },
    {
      threadId: "visa",
      title: "Check the visa",
      createdAt: now - 200_000,
      openedBy: opener,
      activity: "waiting-on-you",
    },
    {
      threadId: "hotel",
      title: "Find a hotel",
      createdAt: now - 100_000,
      openedBy: opener,
      unread: true,
    },
  ],
} as unknown as Bot;
const channel: StoreChannel = {
  read: () => state,
  listen: () => noop,
  dispatch: noop,
  flushBotPatches: async () => null,
  refreshInstances: async () => {},
  refreshModels: async () => {},
};

function OpenOtherMenus() {
  const header = useRef<HTMLDivElement>(null);
  const message = useRef<HTMLDivElement>(null);
  useEffect(() => {
    header.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click();
    message.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click();
  }, []);
  return (
    <StoreChannelContext.Provider value={channel}>
      <div className="flex gap-24 p-8">
        <div ref={header} data-preview="chat-header-menu" className="relative w-[300px]">
          <div className="flex justify-end">
            <ChatHeaderMenu bot={juniperWithTasks} messages={[]} onFind={noop} />
          </div>
        </div>
        <div
          ref={message}
          data-preview="message-menu"
          className="group relative mt-4 flex w-[300px] flex-col items-start"
        >
          <div className="rounded-bubble bg-card px-4 py-2.5 text-[15px]">
            Your trip notes are ready to read.
          </div>
          <MessageActions
            side="bot"
            forceOpen
            more={[
              { key: "copy", label: "Copy", icon: <Copy size={16} />, onSelect: noop },
              {
                key: "edit",
                label: "Edit",
                icon: <Pencil size={16} />,
                active: true,
                onSelect: noop,
              },
              {
                key: "delete",
                label: "Delete",
                icon: <Trash2 size={16} />,
                separatorBefore: true,
                onSelect: noop,
              },
            ]}
          >
            <span />
          </MessageActions>
        </div>
      </div>
    </StoreChannelContext.Provider>
  );
}

function Preview() {
  if (params.get("view") === "menus")
    return (
      <div className="h-screen bg-app text-ink">
        <OpenOtherMenus />
      </div>
    );
  return (
    <div className="flex h-screen bg-app text-ink">
      <aside
        data-preview="rail"
        className="flex h-full w-[80px] shrink-0 flex-col border-r border-hairline/40 bg-panel"
      >
        <Rows density="icons" />
      </aside>
      <aside
        data-preview="expanded"
        className="flex h-full w-[300px] shrink-0 flex-col border-r border-hairline/40 bg-panel"
      >
        <Rows density="comfortable" />
      </aside>
      <main className="flex-1 p-8">
        <OpenMenu />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
