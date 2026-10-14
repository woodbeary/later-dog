import { lazy, Suspense, useEffect } from "react";
import { closeExchange, useOpenExchange } from "@/lib/exchange-view";

const ExchangeView = lazy(() => import("./ExchangeView"));

export function ExchangeViewHost({ botId }: { botId: string }) {
  const open = useOpenExchange();
  useEffect(() => closeExchange, [botId]);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <ExchangeView groupId={open} />
    </Suspense>
  );
}
