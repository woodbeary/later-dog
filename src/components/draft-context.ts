import { createContext } from "react";

export interface DraftScope {
  botName?: string;
  send?: (text: string) => void;
  earlier: (messageId: string | undefined) => string[];
}

export const DraftContext = createContext<DraftScope>({ earlier: () => [] });
