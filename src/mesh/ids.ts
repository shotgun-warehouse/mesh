import { DEVICE_ID_BYTES } from "./constants";

/** Random v4 UUID, used for packet IDs. */
export function createUuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
    /[xy]/g,
    (character) => {
      const randomNibble = Math.floor(Math.random() * 16);
      const value =
        character === "x" ? randomNibble : (randomNibble & 0x3) | 0x8;
      return value.toString(16);
    },
  );
}

const DEVICE_ID_PATTERN = new RegExp(`^[0-9a-f]{${DEVICE_ID_BYTES * 2}}$`);

/** A device ID is `DEVICE_ID_BYTES` bytes as lowercase hex. */
export function isDeviceId(value: string): boolean {
  return DEVICE_ID_PATTERN.test(value);
}

/** 32-bit FNV-1a over the string's UTF-16 code units. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The device ID derived from an app-level device key (`MeshProvider`'s `deviceKey`): its FNV-1a
 * hash as lowercase hex. Items seeded with `addItems` get their author the same way, so an item
 * this device published and the server's copy of it share one `(author, seq)`.
 */
export function deviceIdFromKey(deviceKey: string): string {
  return fnv1a(deviceKey)
    .toString(16)
    .padStart(DEVICE_ID_BYTES * 2, "0");
}

/**
 * Random device ID. The native module persists the real one per install; this is only the
 * fallback when it cannot (web).
 */
export function createDeviceId(): string {
  let deviceId = "";
  for (let index = 0; index < DEVICE_ID_BYTES; index += 1) {
    deviceId += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return deviceId;
}
