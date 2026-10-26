export const DOG_NAME_LIMIT = 100;

export interface NewChatDog {
  id: string;
  name: string;
  hidden?: boolean;
}

export type NewChatRow<Dog extends NewChatDog = NewChatDog> =
  | { kind: "create-dog"; name: string | null }
  | { kind: "create-group" }
  | { kind: "dog"; dog: Dog; picked: boolean };

export function newChatRows<Dog extends NewChatDog>(input: { dogs: readonly Dog[]; query: string; grouping: boolean; picked: readonly string[] }): NewChatRow<Dog>[] {
  const typed = input.query.trim();
  const words = typed.toLowerCase();
  const matches = input.dogs.filter((dog) => (words ? dog.name.toLowerCase().includes(words) : !dog.hidden));
  const dogs: NewChatRow<Dog>[] = matches.map((dog) => ({ kind: "dog", dog, picked: input.picked.includes(dog.id) }));
  if (input.grouping) return dogs;
  if (!typed) return [{ kind: "create-dog", name: null }, { kind: "create-group" }, ...dogs];
  const taken = input.dogs.some((dog) => dog.name.trim().toLowerCase() === words);
  return taken ? dogs : [{ kind: "create-dog", name: typed.slice(0, DOG_NAME_LIMIT) }, ...dogs];
}

export function rowKey(row: NewChatRow): string {
  return row.kind === "dog" ? row.dog.id : row.kind;
}

export function nextActive(active: number, count: number, step: 1 | -1): number {
  if (count <= 0) return 0;
  return (active + step + count) % count;
}
