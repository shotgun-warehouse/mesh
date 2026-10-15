import { fnv1a } from "../mesh/ids";

/**
 * One element of the replicated set. The set only grows: an item is never changed or removed,
 * and `(author, seq)` identifies it everywhere.
 */
export type MeshItem = {
  /** Device ID of the device that published it. */
  author: string;
  /** Per-author counter, from 1 with no gaps. */
  seq: number;
  /** When the author published it (ms since epoch). */
  createdAt: number;
  /** App payload (usually JSON), at most `MAX_ITEM_DATA_BYTES` of UTF-8 (4 KB). */
  data: string;
};

/** Per author, the highest seq such that every item up to it is held. */
export type MeshVersionVector = Record<string, number>;

export function meshItemKey(item: Pick<MeshItem, "author" | "seq">): string {
  return `${item.author}:${item.seq}`;
}

/**
 * An item the app already holds elsewhere (its server), handed to `addItems`. `deviceKey` is the
 * author's `deviceKey`; the library derives the author's device ID from it.
 */
export type MeshKeyedItem = Omit<MeshItem, "author"> & { deviceKey: string };

/** 32-bit FNV-1a of a sync scope: what sync packets carry to tell scopes apart. */
export function scopeHash(scope: string): number {
  return fnv1a(scope);
}
