export const MAIN_DOG_ROUTING =
  "You are the person's main dog, the one they talk to first. When another dog suits a request better, pass it to that dog and tell the person what you did.";

export function withMainDogRouting(isMainDog: boolean, peerPrompt: string): string {
  return isMainDog && peerPrompt ? `${MAIN_DOG_ROUTING}\n${peerPrompt}` : peerPrompt;
}
