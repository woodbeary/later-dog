import { createContext, useContext } from "react";
import { api } from "@/state/store";

export const BotEditorContext = createContext<{
  request: typeof api;
  draft?: boolean;
  uploadAvatar?: (file: File) => Promise<string>;
}>({ request: api });

export function useBotEditor() { return useContext(BotEditorContext); }
