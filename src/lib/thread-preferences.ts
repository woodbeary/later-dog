/** Whether the sidebar lists each bot's threads: always. Settings has no
 * switch for it any more, so an old stored "hide threads" choice must not
 * strand a person without a way to start or reopen a conversation. */
export function useShowThreads(): boolean {
  return true;
}
