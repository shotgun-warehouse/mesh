import { seqFloorsOf, type MeshItemPersistence } from "@sync/persistence";
import type { MeshItem, MeshVersionVector } from "@sync/types";

/** The phone's disk: the library's item files survive app kills, not factory resets. */
export function createMemoryPersistence(gate?: Promise<void>) {
  const files = new Map<string, MeshItem[]>();
  const seqFloors = new Map<string, MeshVersionVector>();
  const persistence: MeshItemPersistence = {
    load: async (scope) => {
      await gate;
      return {
        items: [...(files.get(scope) ?? [])],
        seqFloors: { ...seqFloors.get(scope) },
      };
    },
    append: async (scope, items) => {
      files.set(scope, [...(files.get(scope) ?? []), ...items]);
    },
    clearAll: async () => {
      for (const [scope, items] of files) {
        seqFloors.set(scope, seqFloorsOf(items, seqFloors.get(scope) ?? {}));
      }
      files.clear();
    },
  };
  return { files, seqFloors, persistence };
}
