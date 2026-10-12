
export interface TurnStartLog {
  botId: string;
  text: string;
  images: number;
  depth: number;
  card: boolean;
  spoken: boolean;
}

const LOGGED_CHARS = 70;

export function turnStartLogLine(turn: TurnStartLog): string {
  const text = turn.spoken ? "(spoken)" : JSON.stringify(turn.text.slice(0, LOGGED_CHARS));
  return `[laterdog-turn] bot=${turn.botId} text=${text} images=${turn.images} depth=${turn.depth} card=${turn.card}`;
}
