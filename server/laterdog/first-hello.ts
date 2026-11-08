export const SEED_GREETING = /^Hi, I'm .+\. What would you like me to do\?$/;

export function personalGreeting(personName: string | undefined, dogName: string): string {
  const person = personName?.trim();
  return person ? `Hi ${person}, I'm ${dogName}.` : `Hi, I'm ${dogName}.`;
}

export function firstHelloPrompt(personName: string | undefined, dogName: string, purpose?: string): string {
  const person = personName?.trim() || "the person";
  const job = purpose?.trim();
  const setUp = job
    ? `${person} just finished setting you up, named you ${dogName} and wrote what you are for: "${job}".`
    : `${person} just finished setting you up and named you ${dogName}.`;
  const guess = job ? "that purpose" : `your name, ${dogName}`;
  return [
    `later.dog first meeting: ${setUp} Say hello first, in one warm message of one or two sentences:`,
    `greet ${person === "the person" ? "them" : person} by name, say it is good to meet them, and say what you guess you are here for from ${guess}`,
    `(for a dog named "taskrabbit replies": "Hey Jacob, good to meet you! Sounds like I'm here to help with your TaskRabbit replies, so let's figure out what that should look like.").`,
    "Do not introduce yourself by name and do not add a second message. Then ask one short question that fits that purpose and helps you",
    "start, such as which side of a service they are on or what kind of work comes first. Use your tool for asking the person a question with",
    "options if you have one, with two to four short options written for that purpose (never generic ones such as Code and GitHub or",
    "Research and writing), and let them answer in their own words; without such a tool, ask in one short line with those options.",
    "Until they answer, do nothing else: no tools besides the question, no setup, no files. Once they answer, start on what they asked",
    "right away with the tools you have, the same as any request. If they close the question without answering, do not ask it again:",
    "tell them in one short line that you are ready whenever they are, and stop.",
  ].join(" ");
}

interface HelloMessage { id: string; role: string; kind?: string; text?: string }
export interface FirstHelloDeps {
  bot(id: string): { id: string; name: string; title?: string; threadId: string; hidden?: boolean; modelSelection: { instanceId: string } } | undefined;
  messages(threadId: string): HelloMessage[];
  patchMessage(threadId: string, messageId: string, patch: { text: string; kind?: "activity" }): void;
  personName(): string | undefined;
  canRun(instanceId: string): Promise<boolean>;
  start(botId: string, threadId: string, prompt: string, introducedBy?: string): Promise<unknown>;
}

export async function sayFirstHello(deps: FirstHelloDeps, botId: string, introducedBy?: string): Promise<{ greeted: boolean; asked: boolean }> {
  const bot = deps.bot(botId);
  if (!bot || bot.hidden) return { greeted: false, asked: false };
  const messages = deps.messages(bot.threadId);
  if (messages.some((message) => message.role === "user")) return { greeted: false, asked: false };
  const person = deps.personName();
  const seed = messages.find((message) => message.role === "bot" && message.kind === "text" && SEED_GREETING.test(message.text ?? ""));
  if (seed) deps.patchMessage(bot.threadId, seed.id, { text: personalGreeting(person, bot.name) });
  if (messages.length > 1 || !(await deps.canRun(bot.modelSelection.instanceId))) return { greeted: Boolean(seed), asked: false };
  if (seed) deps.patchMessage(bot.threadId, seed.id, { kind: "activity", text: "" });
  await deps.start(bot.id, bot.threadId, firstHelloPrompt(person, bot.name, bot.title), introducedBy);
  return { greeted: true, asked: true };
}
