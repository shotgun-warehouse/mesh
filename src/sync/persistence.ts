import type { MeshItem, MeshVersionVector } from "./types";

/** A scope's saved set: its items, and the highest seq per author of items deleted by `clearAll`. */
export type MeshPersistedSet = {
  items: MeshItem[];
  seqFloors: MeshVersionVector;
};

/** Where a device keeps its item set between launches, one set per sync scope. */
export type MeshItemPersistence = {
  load(scope: string): Promise<MeshPersistedSet>;
  append(scope: string, items: MeshItem[]): Promise<void>;
  /**
   * Deletes the items of every scope. Keeps each scope's `seqFloors`, so a device that deleted its
   * own items still numbers its next ones after them.
   */
  clearAll(): Promise<void>;
};

const textEncoder = new TextEncoder();

/** File-safe key of a scope: its UTF-8 bytes as lowercase hex. */
export function scopeFileKey(scope: string): string {
  return Array.from(textEncoder.encode(scope))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** One item per line: `[author, seq, createdAt, data]`. */
export function encodeItemLine(item: MeshItem): string {
  return JSON.stringify([item.author, item.seq, item.createdAt, item.data]);
}

export function decodeItemLine(line: string): MeshItem | null {
  try {
    const [author, seq, createdAt, data] = JSON.parse(line) as unknown[];
    if (
      typeof author === "string" &&
      typeof seq === "number" &&
      typeof createdAt === "number" &&
      typeof data === "string"
    ) {
      return { author, seq, createdAt, data };
    }
  } catch {
    // A torn last line (the app died mid-write): skip it, repair fetches the item again.
  }
  return null;
}

/** The line `clearAll` leaves in a cleared file: `{"seqFloors":{author:seq}}`. */
export function encodeSeqFloorsLine(seqFloors: MeshVersionVector): string {
  return JSON.stringify({ seqFloors });
}

function decodeSeqFloorsLine(line: string): MeshVersionVector | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "seqFloors" in parsed &&
      typeof parsed.seqFloors === "object" &&
      parsed.seqFloors !== null
    ) {
      const seqFloors: MeshVersionVector = {};
      for (const [author, seq] of Object.entries(parsed.seqFloors)) {
        if (typeof seq === "number") {
          seqFloors[author] = seq;
        }
      }
      return seqFloors;
    }
  } catch {
    // Torn line: skipped like a torn item line.
  }
  return null;
}

/** Highest seq per author across `items` and earlier floors. */
export function seqFloorsOf(
  items: MeshItem[],
  seqFloors: MeshVersionVector,
): MeshVersionVector {
  const floors = { ...seqFloors };
  for (const item of items) {
    floors[item.author] = Math.max(floors[item.author] ?? 0, item.seq);
  }
  return floors;
}

/** A file's lines (items and seq floors lines, in any order) as a saved set. */
export function decodePersistedLines(lines: string[]): MeshPersistedSet {
  const items: MeshItem[] = [];
  const seqFloors: MeshVersionVector = {};
  for (const line of lines) {
    const item = decodeItemLine(line);
    if (item) {
      items.push(item);
      continue;
    }
    const floors = decodeSeqFloorsLine(line);
    if (floors) {
      for (const [author, seq] of Object.entries(floors)) {
        seqFloors[author] = Math.max(seqFloors[author] ?? 0, seq);
      }
    }
  }
  return { items, seqFloors };
}
