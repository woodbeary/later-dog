declare global {
  type CompanyBackupEntry = Omit<import("../../electron/company-backups.mjs").CompanyBackupMetadata, "status"> & { status: "creating" | "uploading" | "completing" | "ready" | "cleanup" };
  interface CompanyBackupScheduleState {
    enabled: boolean;
    status: "off" | "waiting" | "running" | "paused" | "error";
    nextBackupAt?: number;
    lastAttemptAt?: number;
    lastBackupAt?: number;
    message?: string;
  }
  interface CompanyBackupState {
    busy: boolean;
    pendingRestore?: boolean;
    kind?: "backup" | "restore";
    progress?: import("../../electron/company-backups.mjs").CompanyBackupProgress;
    message?: string;
    lastBackupAt?: number;
    schedule?: CompanyBackupScheduleState;
  }
const __APP_VERSION__: string;

  type DesktopSharedFolder = import("../../electron/computer-sharing.mjs").SharedFolder;
  type DesktopComputerSharing = import("../../electron/computer-sharing.mjs").SharingState;
  type DesktopLendingActivity = import("../../electron/computer-sharing.mjs").LendingActivityEntry;

  type DesktopCapabilities = {
    host: {
      platform: "darwin" | "linux" | "win32" | "other";
      homeDir?: string;
      label: string;
      session: "x11" | "wayland" | "headless" | "unknown";
      packaged: boolean;
    };
    windowChrome: "mac-inset" | "win-caption" | "native";
    screenPreview: {
      available: boolean;
      interaction: "direct" | "portal-picker" | "none";
      reasonCode?: string;
    };
    dictation: {
      available: boolean;
      engine: "apple-speech" | "none";
      onDevice: boolean;
      reasonCode?: string;
    };
    localComputer: {
      available: boolean;
      support: "supported" | "limited" | "unsupported";
      enabled: boolean;
      status: "disabled" | "checking" | "starting" | "ready" | "error" | "stopped" | "unavailable";
      reasonCode?: string;
      message?: string;
      driverPath?: string;
      driverVersion?: string;
      driverSource?: "bundled" | "environment" | "user-local" | "path";
      session?: "x11" | "wayland" | "headless" | "unknown";
      compositor?: "gnome-mutter";
    };
    credentialStore?: "ok" | "unavailable";
  };

  interface DesktopWorkspaceBounds {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface BrowserSurfaceState {
    botId: string;
    open: boolean;
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward?: boolean;
    visible: boolean;
    partition?: string | null;
    profile?: string | null;
    mode?: "compact" | "expanded" | null;
    code?: "renderer-gone" | "profile-deleted" | "evicted";
  }

  interface DesktopWorkspaceState {
    contextId: string;
    open: boolean;
    status: "opening" | "ready" | "error" | "closed";
    interactive: boolean;
    code?: "load-failed" | "renderer-gone";
  }

  interface DesktopRoutineWake {
    keepAwake: boolean;
    hold: boolean;
    reason: string;
    at: number | null;
    onBattery: boolean;
  }
  interface DesktopRemoteClientState {
    active: boolean;
    endpoint?: string;
    serverName?: string;
    deviceId?: string;
  }
  interface DesktopProfile {
    id: string;
    name: string;
    main: boolean;
    status: "starting" | "running" | "failed" | "stopped";
  }
  interface DesktopProfileList {
    activeId: string;
    canAdd: boolean;
    profiles: DesktopProfile[];
  }

  interface Window {
    laterdog?: {
      platform: NodeJS.Platform;
      organization?: import("../../electron/managed-desktop.mjs").ManagedDesktopBridge;
      cloudAccount?: import("../../electron/cloud-account.mjs").CloudAccountBridge;
      cloudMove?: import("../../electron/cloud-move.mjs").CloudMoveBridge;
      cloudLending?: { open(): Promise<void> };
      cloudPlan?: import("../../electron/cloud-account.mjs").CloudPlanBridge;
      companyBackups?: {
        state(): Promise<CompanyBackupState>;
        list(): Promise<{ backups: CompanyBackupEntry[]; usedBytes: number; limits: { ownerQuotaBytes: number; retainedSnapshots: number } }>;
        create(input: { clientState: import("../../shared/workspace-backup").WorkspaceBackupClientState }): Promise<CompanyBackupEntry>;
        configureSchedule?(input: { enabled: false } | { enabled: true; confirmation: "BACK UP THIS WORKSPACE DAILY" }): Promise<CompanyBackupState>;
        prepareRestore(input: { id: string; password?: string }): Promise<{ id: string; summary: import("../../shared/workspace-backup").WorkspaceBackupSummary }>;
        restore(input: { id: string; confirmation: "REPLACE" }): Promise<{ restoreId: string }>;
        delete(input: { id: string; confirmation: "DELETE" }): Promise<unknown>;
        cancel(): Promise<void>;
        onState(callback: (state: CompanyBackupState) => void): () => void;
      };
      workspaces?: {
        state: () => Promise<{ local: boolean; name: string; origin?: string }>;
        menu: () => Promise<void>;
      };
      profiles?: {
        list(): Promise<DesktopProfileList>;
        add(name: string): Promise<DesktopProfileList & { added: { id: string; ready: boolean } }>;
        switch(id: string): Promise<DesktopProfileList>;
        rename(id: string, name: string): Promise<DesktopProfileList>;
        remove(id: string): Promise<DesktopProfileList>;
        onChanged(callback: (state: DesktopProfileList) => void): () => void;
      };
      environments?: {
        state: () => Promise<{
          localOrigin: string;
          remote: boolean;
          activeId: string;
          environments: Array<{ id: string; name: string; origin: string }>;
        }>;
        switch: (id: string) => Promise<void>;
        addFromLink: (link: string, name?: string) => Promise<boolean | void>;
        forget: (id: string) => Promise<void>;
        onOpenSettings?: (callback: (computerId?: string | null, panel?: "copy") => void) => () => void;
      };
      computerSharing?: {
        state(id: string): Promise<DesktopComputerSharing>;
        chooseFolder(): Promise<DesktopSharedFolder | null>;
        save(id: string, grant: Pick<DesktopComputerSharing, "folders" | "terminal" | "computer">): Promise<DesktopComputerSharing | null>;
        revoke(id: string): Promise<DesktopComputerSharing>;
        activity(id: string): Promise<DesktopLendingActivity[]>;
      };
      confirm(message: string): Promise<boolean>;
      getCapabilities(): Promise<DesktopCapabilities>;
      onCapabilitiesChanged(cb: (capabilities: DesktopCapabilities) => void): () => void;
      remoteClient?: {
        active: boolean;
        state(): Promise<DesktopRemoteClientState>;
        pair(endpoint: string, code: string): Promise<DesktopRemoteClientState>;
        disconnect(): Promise<DesktopRemoteClientState>;
      };
      routines?: {
        wakeState(): Promise<DesktopRoutineWake>;
        keepAwake(enabled: boolean): Promise<DesktopRoutineWake>;
      };
      companionAccount?: {
        state(): Promise<CompanionAccountState>;
        requestCode(email: string): Promise<CompanionAccountState>;
        verifyCode(email: string, code: string): Promise<CompanionAccountState>;
        retry(): Promise<CompanionAccountState>;
        signOut(): Promise<CompanionAccountState>;
      };
      approvals?: {
        setMode(
          botId: string,
          mode: import("../../shared/approval-mode").ApprovalMode,
          options?: { acknowledgeLocalAuto?: boolean; threadId?: string; threadOnly?: boolean; allThreads?: boolean;
            refreshPermissions?: boolean;
            modelSelection?: import("../state/store").ModelSelection; updateBotDefault?: boolean },
        ): Promise<import("../state/store").Bot>;
      };
      localControl: {
        status(): Promise<LinuxLocalControlStatus>;
        enable(): Promise<LinuxLocalControlStatus>;
        disable(): Promise<LinuxLocalControlStatus>;
        retry(): Promise<LinuxLocalControlStatus>;
      };
      beginScreenPreviewIntent(): boolean;
      screenFrame(): Promise<string | null>;
      androidDevice?: {
        status(): Promise<AndroidDeviceStatus>;
        frame(serial: string): Promise<{ serial: string; dataUrl: string }>;
        input(serial: string, payload: AndroidDeviceInput): Promise<void>;
      };
      speechStart(options?: { endpointMs?: number; file?: string }): Promise<void>;
      speechStop(): Promise<{ recording?: string } | undefined>;
      speechFinish?(): Promise<void>;
      speechAudio?(file: string): Promise<Uint8Array<ArrayBuffer> | null>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null; reason?: string; recording?: string }) => void): () => void;
      getPathForFile?(file: File): string;
      permStatus(): Promise<{ mic: string; pageMic?: "allowed" | "refused" }>;
      permRequestMic(): Promise<boolean>;
      permOpenSettings(pane: "mic" | "screen" | "speech" | "accessibility"): Promise<void>;
      permissions?: import("../lib/desktop-permissions").DesktopPermissionsBridge;
      relaunch?(): Promise<boolean>;
      openInstallTerminal?(command: string): Promise<boolean>;
      copyText?(text: string): Promise<boolean>;
      openExternal?(url: string): Promise<boolean>;
      applySkin?(skin: string): Promise<boolean>;
      windowControls?: {
        minimize(): Promise<boolean>;
        toggleMaximize(): Promise<boolean>;
        close(): Promise<boolean>;
        state(): Promise<{ maximized: boolean }>;
        onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
      };
      onPackageInstall?(cb: (url: string) => void): () => void;
      onOpenAppSettings?(cb: (section?: "organization" | "cloud" | "cloud-settings") => void): () => void;
      setUnreadCount?(count: number): void;
      desktopViewer?: {
        open(url: string, title: string, contextId: string, pill?: { label: string; done: string }): Promise<boolean>;
        close(contextId: string): Promise<boolean>;
        currentState(): Promise<{ open: boolean; contextId: string | null }>;
        onState(cb: (state: { open: boolean; contextId: string | null }) => void): () => void;
      };
      desktopWorkspace?: {
        open(input: {
          contextId: string;
          url: string;
          title: string;
          bounds: DesktopWorkspaceBounds;
        }): Promise<DesktopWorkspaceState>;
        layout(items: Array<{
          contextId: string;
          bounds: DesktopWorkspaceBounds;
          visible: boolean;
        }>): Promise<boolean>;
        setInteractive(contextId: string | null): Promise<boolean>;
        close(contextId?: string): Promise<boolean>;
        onState(cb: (state: DesktopWorkspaceState) => void): () => void;
      };
      pickFolder?(current?: string): Promise<string | null>;
      exportDiagnostics?(): Promise<string | null>;
      saveFile?(filePath: string): Promise<string | null>;
      revealInFolder?(filePath: string): Promise<"shown" | "missing" | "invalid">;
      retryCredentialStore?(): Promise<{ available: boolean }>;
      setCredential?(
        name: "composioApiKey" | "xaiApiKey" | "boxToken" | "opencodeGoApiKey" | "ttsKey" | "fishAudioKey" | "jevApiKey" | "openaiImageApiKey" | "customImageApiKey" | "openaiLiveKey",
        value: string,
      ): Promise<ConfigStatus>;
      updater?: {
        check(): Promise<void>;
        install(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
      releaseCheck?: {
        setEnabled(enabled: boolean): Promise<boolean>;
      };
    };
  }
}

export interface LinuxLocalControlStatus {
  enabled: boolean;
  status: "disabled" | "checking" | "starting" | "ready" | "error" | "stopped" | "unavailable";
  reasonCode?: string;
  message?: string;
  driverPath?: string;
  driverVersion?: string;
  driverSource?: "bundled" | "environment" | "user-local" | "path";
  session?: "x11" | "wayland" | "headless" | "unknown";
  compositor?: "gnome-mutter";
  warnings?: Array<{ label: string; status: string; message: string; detail?: string }>;
}

export interface UpdaterState {
  status:
    | "idle"
    | "checking"
    | "downloading"
    | "preparing"
    | "downloaded"
    | "installing"
    | "handed-off"
    | "error";
  version?: string;
  notes?: string;
  percent?: number;
  message?: string;
  retryable?: boolean;
  installMode?: "restart" | "handoff";
  command?: string;
  terminalOpened?: boolean;
  available?: { version: string; url: string };
  releaseCheck?: "on" | "off";
}

export interface CompanionAccountState {
  available: boolean;
  status: "signed-out" | "connecting" | "ready" | "error";
  email?: string;
  endpoint?: string;
  message?: string;
}

export type AndroidUsbDevice = {
  serial: string;
  state: string;
  connection: "usb";
  model: string;
  product?: string;
  transportId?: string;
};

export type AndroidDeviceStatus = {
  available: boolean;
  reasonCode?: "adb-unavailable" | "adb-failed";
  message?: string;
  devices: AndroidUsbDevice[];
};

export type AndroidDeviceInput =
  | { type: "tap"; x: number; y: number; width: number; height: number }
  | {
      type: "swipe";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      durationMs: number;
      width: number;
      height: number;
    }
  | { type: "key"; key: string; width?: number; height?: number }
  | { type: "text"; text: string; width?: number; height?: number };
