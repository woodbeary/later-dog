import { useEffect, useState } from "react";
import { emailGateDone } from "@/lib/analytics";
import { hostedMember, LOCAL_VIEWER, welcomeDue, welcomeViewer, type WelcomeViewer } from "@/lib/onboarding";
import { api } from "@/state/store";
import { sameFields, useStoreDispatch, useStoreSelector } from "@/state/store-selectors";
import { SharedWorkspaceHint } from "./SharedWorkspaceHint";
import { WelcomeFlow } from "./WelcomeFlow";

export function localDesktopPage(): boolean {
  return window.laterdog?.localPage === true;
}

export function useWelcomeViewer(): WelcomeViewer | null {
  const local = localDesktopPage();
  const [viewer, setViewer] = useState<WelcomeViewer | null>(local ? LOCAL_VIEWER : null);
  useEffect(() => {
    if (local) return;
    let active = true;
    void api("/api/auth/session", { timeoutMs: 10_000 })
      .then((session) => {
        if (active) setViewer(welcomeViewer(session));
      })
      .catch(() => {
        if (active) setViewer(LOCAL_VIEWER);
      });
    return () => {
      active = false;
    };
  }, [local]);
  return viewer;
}

export function WelcomeGate({ viewer, hold = false }: { viewer: WelcomeViewer | null; hold?: boolean }) {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector((store) => ({
    welcomeOpen: store.welcomeOpen,
    appSettingsOpen: store.appSettingsOpen,
    config: store.config,
    firstShownDog: store.bots.find((b) => !b.hidden) ?? null,
  }), sameFields);
  const [dismissed, setDismissed] = useState(false);
  if (!viewer || hold) return null;
  if (hostedMember(viewer)) {
    return (
      <SharedWorkspaceHint
        replay={state.welcomeOpen}
        onClose={() => {
          if (state.welcomeOpen) dispatch({ type: "toggleWelcome", open: false });
        }}
      />
    );
  }
  const due =
    !dismissed &&
    welcomeDue(state.config, {
      legacyDone: emailGateDone(),
      hosted: viewer.hosted,
      canSave: viewer.canSave,
      cloudHome: viewer.cloudHome,
    });
  if (state.appSettingsOpen) return null;
  if (!state.welcomeOpen && !due) return null;
  const bot = state.firstShownDog;
  const replay = state.welcomeOpen && !due;
  return (
    <WelcomeFlow
      bot={bot}
      replay={replay}
      hosted={viewer.hosted}
      onDone={() => {
        setDismissed(true);
        dispatch({ type: "toggleWelcome", open: false });
      }}
    />
  );
}
