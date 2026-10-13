import { DEVICE_ID_BYTES } from "./constants";

/** Random v4 UUID, used for packet, message and transfer IDs. */
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
