import { MAX_ITEM_DATA_BYTES } from "../mesh/constants";
import { fnv1a } from "../mesh/ids";
import { meshItemKey, type MeshItem, type MeshVersionVector } from "./types";

const textEncoder = new TextEncoder();

export function itemDataBytes(data: string): number {
  return textEncoder.encode(data).length;
}

/**
 * The replicated set on this device: a grow-only set of items keyed by `(author, seq)`. Merging is
 * union and re-adding an item does nothing, so every device that holds the same items holds the
 * same set, whatever the order they arrived in. `MeshItemSync` loads it from disk and appends to
 * disk; this is the in-memory index sync works from.
 */
export class MeshItemStore {
  private readonly items = new Map<string, MeshItem>();
  private readonly byAuthor = new Map<string, Map<number, MeshItem>>();
  private readonly contiguous = new Map<string, number>();
  private readonly maxSeq = new Map<string, number>();
  private digestXor = 0;
  /** Items received that were already held. */
  duplicates = 0;

  get size(): number {
    return this.items.size;
  }

  has(author: string, seq: number): boolean {
    return this.byAuthor.get(author)?.has(seq) ?? false;
  }

  get(author: string, seq: number): MeshItem | undefined {
    return this.byAuthor.get(author)?.get(seq);
  }

  /** Adds items; returns the ones that were new. */
  add(items: Iterable<MeshItem>): MeshItem[] {
    const added: MeshItem[] = [];
    for (const item of items) {
      const key = meshItemKey(item);
      if (this.items.has(key)) {
        this.duplicates += 1;
        continue;
      }
      this.items.set(key, item);
      this.digestXor = (this.digestXor ^ fnv1a(key)) >>> 0;
      let seqs = this.byAuthor.get(item.author);
      if (!seqs) {
        seqs = new Map();
        this.byAuthor.set(item.author, seqs);
      }
      seqs.set(item.seq, item);
      this.maxSeq.set(
        item.author,
        Math.max(this.maxSeq.get(item.author) ?? 0, item.seq),
      );
      let prefix = this.contiguous.get(item.author) ?? 0;
      while (seqs.has(prefix + 1)) {
        prefix += 1;
      }
      this.contiguous.set(item.author, prefix);
      added.push(item);
    }
    return added;
  }

  /** Creates and adds this device's next item. */
  createLocal(author: string, data: string, createdAt: number): MeshItem {
    const bytes = itemDataBytes(data);
    if (bytes > MAX_ITEM_DATA_BYTES) {
      throw new Error(
        `Item data is ${bytes} bytes; the limit is ${MAX_ITEM_DATA_BYTES} (MAX_ITEM_DATA_BYTES).`,
      );
    }
    const item: MeshItem = {
      author,
      seq: (this.maxSeq.get(author) ?? 0) + 1,
      createdAt,
      data,
    };
    this.add([item]);
    return item;
  }

  /** The highest seq of `author` this set has held or reserved; 0 when none. */
  highestSeq(author: string): number {
    return this.maxSeq.get(author) ?? 0;
  }

  /** Makes sure this device's next seq is above `seq` (peers know more of its items than it does). */
  reserveSeq(author: string, seq: number): void {
    if (seq > (this.maxSeq.get(author) ?? 0)) {
      this.maxSeq.set(author, seq);
    }
  }

  versionVector(): MeshVersionVector {
    const vector: MeshVersionVector = {};
    for (const author of [...this.contiguous.keys()].sort()) {
      vector[author] = this.contiguous.get(author)!;
    }
    return vector;
  }

  /** XOR of item hashes plus count: equal sets give equal digests. */
  digest(): { xor: number; count: number } {
    return { xor: this.digestXor, count: this.items.size };
  }

  range(author: string, fromSeq: number, toSeq: number): MeshItem[] {
    const seqs = this.byAuthor.get(author);
    if (!seqs) return [];
    const found: MeshItem[] = [];
    for (let seq = fromSeq; seq <= toSeq; seq += 1) {
      const item = seqs.get(seq);
      if (item) found.push(item);
    }
    return found;
  }

  all(): MeshItem[] {
    return [...this.items.values()];
  }
}
