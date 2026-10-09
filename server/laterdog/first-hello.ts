// The first dog speaks first. When first run ends, the dog's chat greets the person by name at once (the static seed
// greeting is rewritten, since it may carry a name the person just changed), and when the dog's engine can answer, a
// hidden turn asks one question: what to help with first, with a few options. Grok Bot's new bots do the same; nothing
// in the transcript looks like the person typed it.

/** The greeting store.createBot seeds into a new dog's chat. */
export const SEED_GREETING = /^Hi, I'm .+\. What would you like me to do\?$/;

export function personalGreeting(personName: string | undefined, dogName: string): string {
  const person = personName?.trim();
  return person ? `Hi ${person}, I'm ${dogName}.` : `Hi, I'm ${dogName}.`;
}

/**
 * The hidden instruction for the dog's first turn. It has already said hello; it asks one question and stops.
 * `purpose` is the line the person wrote when creating the dog (its label): the options then fit that purpose.
 */
export function firstHelloPrompt(personName: string | undefined, dogName: string, purpose?: string): string {
  const person = personName?.trim() || "the person";
  const job = purpose?.trim();
  const setUp = job
    ? `${person} just finished setting you up, named you ${dogName} and wrote what you are for: "${job}".`
    : `${person} just finished setting you up and named you ${dogName}.`;
  const options = job
    ? "that fit that purpose"
    : "that fit a personal assistant who can also code (for example Code and GitHub, Research and writing, Email and calendar, Errands and bookings)";
  return [
    `later.dog first meeting: ${setUp} Your chat already shows`,
    `your hello ("${personalGreeting(personName, dogName)}"), so do not greet again. Ask one short question: what should you`,
    "help with first. Use your tool for asking the person a question with options if you have one, with four short options",
    `${options} and let them answer in their own words; without such a tool, ask in one short line with those`,
    "options. Do nothing else this turn: no tools besides the question, no setup, no files.",
  ].join(" ");
}

interface HelloMessage { id: string; role: string; kind?: string; text?: string }
export interface FirstHelloDeps {
  bot(id: string): { id: string; name: string; title?: string; threadId: string; hidden?: boolean; modelSelection: { instanceId: string } } | undefined;
  messages(threadId: string): HelloMessage[];
  patchMessage(threadId: string, messageId: string, patch: { text: string }): void;
  personName(): string | undefined;
  /** Whether the dog's engine is available and signed in, so the turn can answer instead of showing a sign-in error. */
  canRun(instanceId: string): Promise<boolean>;
  start(botId: string, threadId: string, prompt: string): Promise<unknown>;
}

/** Greets once, in a chat nobody has written in yet. Returns what it did. */
export async function sayFirstHello(deps: FirstHelloDeps, botId: string): Promise<{ greeted: boolean; asked: boolean }> {
  const bot = deps.bot(botId);
  if (!bot || bot.hidden) return { greeted: false, asked: false };
  const messages = deps.messages(bot.threadId);
  if (messages.some((message) => message.role === "user")) return { greeted: false, asked: false };
  const person = deps.personName();
  const seed = messages.find((message) => message.role === "bot" && message.kind === "text" && SEED_GREETING.test(message.text ?? ""));
  if (seed) deps.patchMessage(bot.threadId, seed.id, { text: personalGreeting(person, bot.name) });
  // asked once: a second call (a replayed welcome) finds the question already there
  if (messages.length > 1 || !(await deps.canRun(bot.modelSelection.instanceId))) return { greeted: Boolean(seed), asked: false };
  await deps.start(bot.id, bot.threadId, firstHelloPrompt(person, bot.name, bot.title));
  return { greeted: Boolean(seed), asked: true };
}
