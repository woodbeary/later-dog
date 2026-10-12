
const SETUP_COMMAND = /^\/setup(?:\s+|$)([\s\S]*)$/i;

export function parseSetupCommand(text: string): { request: string } | null {
  const match = text.trim().match(SETUP_COMMAND);
  if (!match) return null;
  return { request: match[1]!.trim() };
}

export function expandSetupTurnText(userText: string): string {
  const setup = parseSetupCommand(userText);
  if (!setup) return userText;
  return setup.request
    ? `Set yourself up for this job: ${setup.request}`
    : "Set yourself up. Ask me what you need to know, then propose your configuration.";
}

export function setupModeActive(input: { soul?: string; description?: string; text: string }): boolean {
  return parseSetupCommand(input.text) !== null;
}

const SKILL_MANAGE_ASIDE = "(keep SOUL.md short; put step-by-step procedure into a skill with skill_manage)";
const NO_SKILL_MANAGE_ASIDE = "(keep SOUL.md short; describe procedures plainly in your standing instructions for now)";

function folderClause(cwd: string | undefined): string {
  return cwd
    ? `which folder on this computer it should work in (today that is ${cwd}; offer to keep it)`
    : "which folder on this computer it should work in (today it has none and works in a private workspace; offer to keep that, or ask for a path)";
}

function buildSetupPrompt(profileAside: string, cwd?: string): string {
  return (
    "\n\nThe user explicitly asked you to set yourself up. For this setup request, help configure the bot from what the user tells you." +
    ` First ask at most four questions that change what you would build: what the job is, when it should happen (on demand, on a schedule, or when something arrives), which apps or accounts it touches, and ${folderClause(cwd)}.` +
    " Then, before any tool call, tell the user in plain language what you intend: who you will be, what you will do and when, where you will work, what you will need from them, and what you will not do. Ask for missing choices, not an extra yes for already-requested actions: changes to your own profile and routines apply immediately, and the person sees each with an Undo." +
    " First send one message describing the changes you are about to request, then make the tool calls. Follow each result: if applied, continue without another confirmation; if pending, end the turn and wait for its in-app decision. Do not repeat the list or claim success from the permission mode alone." +
    ` Use propose_profile for your identity, standing rules ${profileAside}, and the working folder (cwd), propose_routine only for a schedule the user requested, and request_credential for any missing token.` +
    " Full Access does not supply answers, credentials, or broader permissions for another bot. A credential request still needs the user's secure entry. Report failed or cancelled changes honestly." +
    " Finish by saying exactly what remains for the user to do by hand — authorizing an app or account (OAuth), creating a third-party application or bot token, or deciding a pending review — and point them to the Access section of the bot's settings for the app connections."
  );
}

export function setupSystemPrompt(active: boolean, options?: { skills?: boolean; cwd?: string }): string {
  if (!active) return "";
  return buildSetupPrompt(options?.skills ? SKILL_MANAGE_ASIDE : NO_SKILL_MANAGE_ASIDE, options?.cwd);
}
