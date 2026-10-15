import { Platform } from "react-native";

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

export function formatMeshLogLine(
  platform: string,
  layer: "js" | "native",
  tag: string,
  message: string,
  detail?: Record<string, unknown>,
): string {
  const detailSuffix = detail ? ` ${JSON.stringify(detail)}` : "";
  return `[ShotgunMesh][${platform}][${layer}][${tag}] ${message}${detailSuffix}`;
}

export function isMeshLogEmitted(level: MeshLogLevel): boolean {
  if (meshLoggingEnabled) {
    return true;
  }

  return level === "warn" || level === "error";
}

/** Where the router and item sync write their logs. */
export type MeshLogger = (
  tag: string,
  message: string,
  detail?: Record<string, unknown>,
  level?: MeshLogLevel,
) => void;

export function meshLog(
  tag: string,
  message: string,
  detail?: Record<string, unknown>,
  level: MeshLogLevel = "info",
): void {
  if (!isMeshLogEmitted(level)) {
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
