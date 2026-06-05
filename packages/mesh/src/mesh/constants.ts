/** Default hop count for chat and bulk transfers (BitChat-style flooding). */
export const DEFAULT_TTL = 7;

/** TTL for periodic identity beacons — enough to propagate across a small mesh. */
export const IDENTITY_TTL = 4;

export const MESH_PROTOCOL_VERSION = 2;

/** In-memory dedup set size before oldest entries are dropped. */
export const MAX_SEEN_PACKET_IDS = 500;

export const IDENTITY_BEACON_INTERVAL_MS = 5_000;

/** Delay between relay packet writes so the BLE stack can keep up. */
export const RELAY_PUBLISH_DELAY_MS = 100;

/**
 * Pacing between fragment packets in one message.
 * Native sendPacketAsync already waits for ATT write ACKs — keep this minimal (BitChat uses ~20 ms).
 */
export const FRAGMENT_PUBLISH_DELAY_MS = 20;

/**
 * Max encoded wire size for a single mesh packet.
 * BitChat-style: keep each packet within one ATT frame (MTU 517 → 512-byte payload)
 * so centrals never rely on fragile multi-chunk long writes. Larger payloads use
 * application-level fragment packets.
 */
export const MAX_WIRE_BYTES = 512;

/** Target when sizing fragments — small headroom below the 512-byte ATT limit. */
export const MAX_WIRE_FIT_BYTES = MAX_WIRE_BYTES - 12;

/** Starting chunk size before wire-fit trimming (raw payload bytes per fragment). */
export const INITIAL_FRAGMENT_CHUNK_BYTES = 450;

/** Max assembled application message size (256 KB). */
export const MAX_ASSEMBLED_MESSAGE_BYTES = 256 * 1024;

/** Fragment reassembly timeout. */
export const FRAGMENT_ASSEMBLY_TIMEOUT_MS = 120_000;
