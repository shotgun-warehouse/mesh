# Changelog

## 0.2.0

- **Synced items replace messages.** `publishItem(data)` (from `useMesh()`) adds an item to a set that reaches every device of the same `syncScope`, including devices that were away when it was published. The library saves items per scope, deduplicates them, floods fresh ones and repairs gaps with neighbours (anti-entropy). `MeshProvider` gets `syncScope`, `onItemsReceived` and `sync` (knobs, read live).
- **`syncScope` is required and can be `null`.** `null` turns sync off (no set loaded, nothing published or received; the mesh still relays). The `"default"` scope is gone.
- **`deviceKey` prop.** The device ID can be derived from the app's own per-install ID (a 32-bit FNV-1a hash), so a server that knows the device and an item's `seq` can name the mesh item.
- **`addItems(scope, items)`** on `useMesh()` seeds the set with items the app got from its server: saved, served to neighbours, neither flooded nor passed to `onItemsReceived`. Rejects when `scope` is not the current one.
- **`clearMeshItems()`** deletes every stored item, in every scope, with or without a mounted provider (for example on logout). The device's next items still number after the deleted ones.
- **Repair compares right away** when `repair` turns on and when a sync instance starts (scope switch, set loaded) with neighbours already linked, instead of waiting for two differing digests.
- **Requests skip seqs already held** past the contiguous prefix, so a seeded set with gaps asks only for what it lacks; `maxItemsPerRequest` counts requested seqs.
- Removed `broadcast`, `useMeshMessages`, `MeshInboundMessage` and `MeshNotRunningError`. The package now exports `MeshProvider`, `useMesh`, `clearMeshItems` and the `MeshItem` type only.
- Native: `sendPacketAsync` takes a target mesh ID; new item file functions (`readItemsAsync`, `appendItemsAsync`, `listItemFilesAsync`, `replaceItemsAsync`). Needs a new development build.
- Wire format: identity plus four sync packet types (item parts, digest, version vector, request). Message and fragment packets are gone, and the router with them: it only relays identity beacons and sync packets.
- Fixed `readUint32BE` returning negative numbers for values ≥ 2³¹.

## 0.1.0

- Initial release.
