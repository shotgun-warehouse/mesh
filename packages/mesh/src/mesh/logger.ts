import { Platform } from "react-native";

import BleBroadcast, { type MeshLogEvent } from "../../modules/ble-broadcast";

export type MeshLogLevel = "debug" | "info" | "warn" | "error";

let meshLoggingEnabled = false;

export function setMeshLoggingEnabled(enabled: boolean): void {
  meshLoggingEnabled = enabled;
}

function getPlatformLabel(): string {
  if (Platform.OS === "ios") {
    return "ios";
  }

  if (Platform.OS === "android") {
    return "android";
  }

  return Platform.OS;
}

function formatMeshLogLine(
  platform: string,
  layer: "js" | "native",
  tag: string,
  message: string,
  detail?: Record<string, unknown>,
): string {
  const detailSuffix = detail ? ` ${JSON.stringify(detail)}` : "";
  return `[ShotgunMesh][${platform}][${layer}][${tag}] ${message}${detailSuffix}`;
}

function shouldEmitMeshLog(level: MeshLogLevel): boolean {
  if (meshLoggingEnabled) {
    return true;
  }

  return level === "warn" || level === "error";
}

export function meshLog(
  tag: string,
  message: string,
  detail?: Record<string, unknown>,
  level: MeshLogLevel = "info",
): void {
  if (!shouldEmitMeshLog(level)) {
    return;
  }

  const line = formatMeshLogLine(
    getPlatformLabel(),
    "js",
    tag,
    message,
    detail,
  );

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export function attachNativeMeshLogs(): { remove: () => void } {
  return BleBroadcast.addListener("onMeshLog", (event: MeshLogEvent) => {
    if (!shouldEmitMeshLog(event.level)) {
      return;
    }

    let detail: Record<string, unknown> | undefined;
    if (event.detail) {
      try {
        detail = JSON.parse(event.detail) as Record<string, unknown>;
      } catch {
        detail = { rawDetail: event.detail };
      }
    }

    const line = formatMeshLogLine(
      event.platform,
      "native",
      event.tag,
      event.message,
      detail,
    );

    if (event.level === "error") {
      console.error(line);
      return;
    }

    if (event.level === "warn") {
      console.warn(line);
      return;
    }

    console.log(line);
  });
}
