export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 1) {
    binary += String.fromCharCode(bytes[offset]!);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const normalized = base64.replace(/[^A-Za-z0-9+/=]/g, "");
    if (normalized.length === 0) {
      return null;
    }

    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

const textEncoder = new TextEncoder();

/** Truncate UTF-8 text to at most maxBytes without splitting a code point. */
export function truncateUtf8ToBytes(
  text: string,
  maxBytes: number,
): Uint8Array {
  const encoded = textEncoder.encode(text);
  if (encoded.length <= maxBytes) {
    return encoded;
  }

  let end = maxBytes;
  while (end > 0 && (encoded[end - 1]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return encoded.slice(0, end);
}

export function uuidStringToBytes(uuid: string): Uint8Array | null {
  const normalized = uuid.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    return null;
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function uuidBytesToString(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

export function writeUint16BE(
  bytes: Uint8Array,
  offset: number,
  value: number,
): void {
  bytes[offset] = (value >> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) >>> 0) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!
  );
}

export function writeUint32BE(
  bytes: Uint8Array,
  offset: number,
  value: number,
): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
