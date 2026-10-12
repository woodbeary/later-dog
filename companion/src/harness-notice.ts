import { request as httpRequest } from "node:http";

import { companionIdentityHeaders } from "./proxy.ts";

const DEVICE_ID = /^[\w-]{1,128}$/;
const NOTICE_TIMEOUT_MS = 4_000;

export interface DeviceRevokedNotice {
  harnessPort: number;
  deviceId: string;
  mutationToken?: string;
  timeoutMs?: number;
}

export function notifyDeviceRevoked(notice: DeviceRevokedNotice): Promise<boolean> {
  return new Promise((resolve) => {
    if (!DEVICE_ID.test(notice.deviceId)) {
      resolve(false);
      return;
    }
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: notice.harnessPort,
        path: "/api/live/device-revoked",
        method: "POST",
        headers: { ...companionIdentityHeaders(notice.deviceId, notice.mutationToken), "content-length": "0" },
        timeout: notice.timeoutMs ?? NOTICE_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 500;
        resolve(status >= 200 && status < 300);
      },
    );
    request.on("timeout", () => request.destroy(new Error("the harness did not answer")));
    request.on("error", () => resolve(false));
    request.end();
  });
}
