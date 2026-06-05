import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";

export type MeshPacket = {
  type: "mesh.packet";
  v: 1;
  encoding: "gzip" | "json";
  data: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function gzipEncodeJson(jsonPayload: string): string {
  const gzipEnvelope = JSON.stringify({
    type: "mesh.packet",
    v: 1,
    encoding: "gzip",
    data: bytesToBase64(gzipSync(strToU8(jsonPayload))),
  } satisfies MeshPacket);

  const jsonEnvelope = JSON.stringify({
    type: "mesh.packet",
    v: 1,
    encoding: "json",
    data: jsonPayload,
  });

  return jsonEnvelope.length <= gzipEnvelope.length
    ? jsonEnvelope
    : gzipEnvelope;
}

export function gzipDecodeJson(wirePayload: string): string | null {
  try {
    const packet = JSON.parse(wirePayload) as Partial<MeshPacket>;
    if (packet.type !== "mesh.packet" || typeof packet.data !== "string") {
      return null;
    }

    if (packet.encoding === "json") {
      return packet.data;
    }

    if (packet.encoding !== "gzip") {
      return null;
    }

    return strFromU8(gunzipSync(base64ToBytes(packet.data)));
  } catch {
    return null;
  }
}
