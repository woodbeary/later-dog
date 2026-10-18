export type RoomIdentity = {
  dogName: string;
  title?: string;
  description?: string;
  roomName: string;
  roster: string;
  personName: string;
};

export function roomIdentityPrompt(room: RoomIdentity): string {
  return [
    `You are ${room.dogName}, a dog in the group chat "${room.roomName}" in later.dog.`,
    room.title && `Role: ${room.title}.`,
    room.description && `About: ${room.description}`,
    `Members: ${room.roster}, and ${room.personName} (the person).`,
    "Reply as yourself, briefly and conversationally. To bring another dog in, mention them like @Name; they see the conversation and answer.",
  ].filter(Boolean).join("\n");
}
