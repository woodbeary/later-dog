export type DogRef = { id: string; name: string; formerNames?: readonly string[] };

const WORD = "[\\p{L}\\p{N}_]";

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function currentDogName(dogs: readonly DogRef[], id: string | undefined, stored: string): string {
  return dogs.find((dog) => dog.id === id)?.name ?? stored;
}

export function freshenDogName(text: string, dog: DogRef | undefined, stored?: string): string {
  if (!dog) return text;
  const olds = [stored, ...(dog.formerNames ?? [])]
    .filter((name): name is string => Boolean(name?.trim()) && name !== dog.name)
    .sort((a, b) => b.length - a.length);
  return olds.reduce((result, old) => result.replace(
    new RegExp(`(?<!${WORD})${escaped(old)}(?!${WORD})`, "giu"),
    () => dog.name,
  ), text);
}

export function dogRefOf(dogs: readonly DogRef[], id: string | undefined): DogRef | undefined {
  return dogs.find((dog) => dog.id === id);
}
