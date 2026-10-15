export type Rng = () => number;

/** mulberry32: tiny, fast, good enough for simulation. Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a. */
export function fnv1a(text: string, hash = 0x811c9dc5): number {
  let result = hash >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    result ^= text.charCodeAt(index);
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result;
}

/**
 * Independent PRNG streams derived from one seed. Each consumer draws from its own stream, so
 * changing how often one draws (more writes under other sync knobs) never shifts another (the scan
 * schedule), and Compare mode runs see the same scans and link churn.
 */
export class RandomStreams {
  /** Discovery delays, link churn, device churn. */
  readonly medium: Rng;
  /** Write loss and latency jitter. */
  readonly loss: Rng;
  /** Auto scans: timing and tickets. */
  readonly generator: Rng;
  /** Stands in for `Math.random` while the run executes: packet IDs and UUIDs. */
  readonly uuid: Rng;
  /** Mesh IDs of new or factory-reset devices. */
  readonly ids: Rng;

  constructor(readonly seed: number) {
    this.medium = mulberry32(fnv1a(`medium:${seed}`));
    this.loss = mulberry32(fnv1a(`loss:${seed}`));
    this.generator = mulberry32(fnv1a(`generator:${seed}`));
    this.uuid = mulberry32(fnv1a(`uuid:${seed}`));
    this.ids = mulberry32(fnv1a(`ids:${seed}`));
  }
}

export function uniform(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

/** Exponentially distributed value with the given mean. */
export function exponential(rng: Rng, mean: number): number {
  return -Math.log(1 - rng()) * mean;
}

export function randomHex(rng: Rng, byteCount: number): string {
  let hex = "";
  for (let index = 0; index < byteCount; index += 1) {
    hex += Math.floor(rng() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return hex;
}
