import BleBroadcast from "../native";
import {
  decodePersistedLines,
  encodeItemLine,
  encodeSeqFloorsLine,
  scopeFileKey,
  seqFloorsOf,
  type MeshItemPersistence,
} from "./persistence";

/** Item sets in an append-only file per scope, written by the native module. */
export const nativeItemPersistence: MeshItemPersistence = {
  async load(scope) {
    return decodePersistedLines(
      await BleBroadcast.readItemsAsync(scopeFileKey(scope)),
    );
  },
  append: (scope, items) =>
    BleBroadcast.appendItemsAsync(
      scopeFileKey(scope),
      items.map(encodeItemLine),
    ),
  async clearAll() {
    for (const fileKey of await BleBroadcast.listItemFilesAsync()) {
      const { items, seqFloors } = decodePersistedLines(
        await BleBroadcast.readItemsAsync(fileKey),
      );
      const floors = seqFloorsOf(items, seqFloors);
      await BleBroadcast.replaceItemsAsync(
        fileKey,
        Object.keys(floors).length > 0 ? [encodeSeqFloorsLine(floors)] : [],
      );
    }
  },
};
