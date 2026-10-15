/**
 * Bytes in a device ID (the per-install ID in every packet header and in the advertisement).
 * 4 bytes keeps an accidental ID collision below one in 800,000 for a 100-device event;
 * 2 bytes would collide in about 7% of 100-device events.
 */
export const DEVICE_ID_BYTES = 4;

/** TTL for periodic identity beacons — enough to propagate across a small mesh. */
export const IDENTITY_TTL = 4;

/** In-memory dedup set size before oldest entries are dropped. */
export const MAX_SEEN_PACKET_IDS = 500;

/** Start attempts in a row before the mesh reports `error`. */
export const MAX_START_ATTEMPTS = 3;

/** Wait before the second start attempt; doubles before each later attempt (1 s, then 2 s). */
export const START_RETRY_BASE_DELAY_MS = 1_000;

export const IDENTITY_BEACON_INTERVAL_MS = 5_000;

/** Max wire payloads held while no peer can accept writes; oldest are dropped first. */
export const MAX_PENDING_WIRE_PAYLOADS = 100;

/** Delay between relay packet writes so the BLE stack can keep up. */
export const RELAY_PUBLISH_DELAY_MS = 100;

/**
 * Max encoded wire size for a single mesh packet.
 * BitChat-style: keep each packet within one ATT frame (MTU 517 → 512-byte payload)
 * so centrals never rely on fragile multi-chunk long writes. Larger items travel in
 * parts (`ITEM_PART_BYTES`).
 */
export const MAX_WIRE_BYTES = 512;

/** Max UTF-8 bytes in a synced item's `data`. Items over one packet travel in parts. */
export const MAX_ITEM_DATA_BYTES = 4096;

/** UTF-8 bytes of item data per part: a part, with its header, fits one addressed packet. */
export const ITEM_PART_BYTES = 440;
