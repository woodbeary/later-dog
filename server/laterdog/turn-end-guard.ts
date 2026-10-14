export function guardTurnEnd<Event extends { type: string }>(
  listener: (event: Event) => void,
  recover: (event: Event, error: unknown) => void,
): (event: Event) => void {
  return (event) => {
    try {
      listener(event);
    } catch (error) {
      if (event.type === "turn.completed") {
        try {
          recover(event, error);
        } catch (inner) {
          console.error("turn end: recovery could not start", inner);
        }
      }
      throw error;
    }
  };
}
