import { useEffect } from "react";
import { ChevronLeft, X } from "lucide-react";
import { backWorkPanel, closeWorkPanel, useWorkPanel, workPanelCanGoBack } from "@/lib/work-panel";

export function WorkPanel(props: { botId: string; botName: string }) {
  const page = useWorkPanel();
  useEffect(() => {
    if (!page) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) closeWorkPanel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [page]);
  if (!page) return null;
  const back = workPanelCanGoBack();
  return (
    <aside data-work-panel data-bot-id={props.botId} aria-label={props.botName} className="work-panel animate-panel-in">
      <header className="work-panel-header">
        <button type="button" className="work-panel-close" onClick={back ? backWorkPanel : closeWorkPanel} aria-label={back ? "Back" : "Close"}>
          {back ? <ChevronLeft size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
        </button>
      </header>
    </aside>
  );
}
