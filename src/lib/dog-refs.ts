export type DogRef = { id: string; name: string; formerNames?: readonly string[] };

const WORD = "[\\p{L}\\p{N}_]";

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function currentDogName(dogs: readonly DogRef[], id: string | undefined, stored: string): string {
  return dogs.find((dog) => dog.id === id)?.name ?? stored;
}

function earlierNames(dog: DogRef, stored: string | undefined): string[] {
  return [stored, ...(dog.formerNames ?? [])]
    .filter((name): name is string => Boolean(name?.trim()) && name !== dog.name)
    .sort((a, b) => b.length - a.length);
}

export function freshenDogName(text: string, dog: DogRef | undefined, stored?: string, options: { leading?: boolean } = {}): string {
  if (!dog) return text;
  return earlierNames(dog, stored).reduce((result, old) => {
    const name = escaped(old);
    const patterns = [
      new RegExp(`(?<![\\p{L}\\p{N}_@])@${name}(?!${WORD})`, "giu"),
      new RegExp(`^(Sent to )${name}(?= · |$)`, "iu"),
      new RegExp(`^((?:Opened|Added to) thread #.* on )${name}$`, "isu"),
      ...(options.leading ? [new RegExp(`^${name}(?= )`, "iu")] : []),
    ];
    return patterns.reduce((text, pattern, index) => text.replace(pattern, (_match, head: unknown) => {
      if (index === 0) return `@${dog.name}`;
      return `${typeof head === "string" ? head : ""}${dog.name}`;
    }), result);
  }, text);
}

export function dogRefOf(dogs: readonly DogRef[], id: string | undefined): DogRef | undefined {
  return dogs.find((dog) => dog.id === id);
}
