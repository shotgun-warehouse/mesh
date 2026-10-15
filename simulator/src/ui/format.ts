import type { PacketKind, PowerState } from "../engine/types";

export function formatTime(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const ms = total % 1_000;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(ms, 3)}`;
}

export function formatShortTime(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

export function formatMs(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return "–";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return formatShortTime(milliseconds);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(fraction >= 0.995 && fraction < 1 ? 1 : 0)}%`;
}

export const POWER_LABEL: Record<PowerState, string> = {
  on: "On",
  bluetoothOff: "Bluetooth off",
  appKilled: "App killed",
};

export const PACKET_COLOR: Record<PacketKind, string> = {
  identity: "#9aa0a6",
  item: "#3b82f6",
  sync: "#f59e0b",
};

/** Stable color per author mesh ID, for item lists. */
export function authorColor(meshId: string): string {
  let hash = 0;
  for (let index = 0; index < meshId.length; index += 1) {
    hash = (hash * 31 + meshId.charCodeAt(index)) >>> 0;
  }
  return `hsl(${hash % 360} 60% 50%)`;
}
