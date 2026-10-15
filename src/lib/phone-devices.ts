import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";

export interface PhoneDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  cloudDesktopAccess: boolean;
  browserControlAccess?: boolean;
}

export interface PhoneDeviceState {
  devices: PhoneDevice[];
}

export interface PhoneDeviceBridge {
  state(): Promise<PhoneDeviceState>;
  cloudDesktop(deviceId: string, allowed: boolean): Promise<PhoneDeviceState>;
  browserControl(deviceId: string, allowed: boolean): Promise<PhoneDeviceState>;
  revoke(deviceId: string): Promise<PhoneDeviceState>;
}

export interface PhoneDeviceController {
  state: PhoneDeviceState | null;
  busy: boolean;
  error: string | null;
  act(call: (bridge: PhoneDeviceBridge) => Promise<PhoneDeviceState>): Promise<void>;
}

export function usePhoneDevices(): PhoneDeviceController {
  const bridge = typeof window !== "undefined" && window.laterdog?.remoteClient?.active !== true
    ? (window.laterdog as { companion?: PhoneDeviceBridge } | undefined)?.companion
    : undefined;
  const [state, setState] = useState<PhoneDeviceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const epoch = useRef(0);
  const revision = useRef(0);

  useEffect(() => {
    const generation = ++epoch.current;
    revision.current++;
    working.current = false;
    setBusy(false);
    setState(null);
    setError(null);
    let loading = false;
    const load = async () => {
      if (!bridge || loading || working.current) return;
      loading = true;
      const before = revision.current;
      try {
        const next = await bridge.state();
        if (epoch.current === generation && before === revision.current) {
          setState(next);
          setError(null);
        }
      } catch {
        if (epoch.current === generation && before === revision.current) setError(t("phone.error.remoteUpdate"));
      } finally { loading = false; }
    };
    void load();
    const timer = bridge ? setInterval(() => void load(), 5_000) : null;
    return () => { epoch.current++; if (timer !== null) clearInterval(timer); };
  }, [bridge]);

  const act = useCallback(async (call: (bridge: PhoneDeviceBridge) => Promise<PhoneDeviceState>) => {
    if (!bridge || working.current) return;
    const generation = epoch.current;
    revision.current++;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await call(bridge);
      if (epoch.current === generation) setState(next);
    } catch {
      if (epoch.current === generation) setError(t("phone.error.remoteUpdate"));
    } finally {
      if (epoch.current === generation) {
        working.current = false;
        setBusy(false);
      }
    }
  }, [bridge]);

  return { state, busy, error, act };
}
