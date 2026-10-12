export const CLOUD_COMPUTER_BUSY_ERROR =
  "this bot's cloud computer is being used by an active turn — interrupt it first";

export function isCloudComputerBusyMessage(message: string): boolean {
  return message.includes(CLOUD_COMPUTER_BUSY_ERROR);
}
