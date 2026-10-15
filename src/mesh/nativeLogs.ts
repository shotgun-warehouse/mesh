import BleBroadcast, { type MeshLogEvent } from "../native";
import { formatMeshLogLine, isMeshLogEmitted } from "./logger";

export function attachNativeMeshLogs(): { remove: () => void } {
  return BleBroadcast.addListener("onMeshLog", (event: MeshLogEvent) => {
    if (!isMeshLogEmitted(event.level)) {
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
