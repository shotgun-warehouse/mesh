# Changelog

## 0.5.1

Android asks for the Bluetooth permissions again when its first request showed no dialog. JS-only change.

- **Android:** a permission request that showed no dialog no longer counts as asked. Android drops a request made while another app permission dialog is on screen (e.g. Stripe Terminal asking at launch), so the mesh never asked again until the next app launch; the foreground refresh after that dialog closes now asks again.

## 0.4.0

A phone can send to a peer as soon as either of them has connected to the other, and a connection that never completes no longer blocks a peer for minutes. Seen in the field: an iPhone's connection to an Android phone that had rotated its Bluetooth address stayed pending, so the iPhone sent nothing to it and the Android listed the iPhone under its short ID. Native and wire change (new GATT characteristic): needs a new development build on every device.

- **Both:** the mesh characteristic supports notifications. A central writes its device ID to a new hello characteristic (`BEF0`), then subscribes. Native sends each packet to a peer once: over its own link when ready, else as a notification over the peer's link to it. Relays skip every link to the peer a packet came from, not only the link it arrived on.
- **Both:** `onPeerConnected` / `onPeerDisconnected` carry a `direction` (`outbound` / `inbound`), `onPeerConnected`'s `rssi` can be null, and `getConnectedPeerCountAsync` counts peers, not links. The router reports a neighbour up on its first link and down on its last, so a peer stays listed and synced while either link is up.
- **iOS:** drops a link not ready 10 s after its connect (it only warned before), and a link still setting up after 5 s gives way to the same peer seen under a new identifier. A dropped link that never got ready no longer fails the send in flight to other peers.
- **Android:** drops a connection attempt not connected after 10 s (the stack's own timeout is ~30 s), with the same replacement by a new address.
- **Both:** a peer linked only inbound gets the RSSI of its last advertisement.
- **JS:** this device's own item parts are no longer paced 100 ms apart nor dropped at the 100-entry relay cap: they have their own cap of 1,000. Publishing many items at once (a photo split into ~27 items in the example app) dropped most of their parts and took ~30 s of pacing alone.

## 0.3.0

iOS links to Android peers recover when the Android phone restarts its mesh, and apps choose how much the mesh logs. Native change: needs a new development build.

- **`logLevel` prop replaces `debug`** on `MeshProvider`: `"info"` prints every JS and native mesh log, `"warn"` warnings and errors, `"error"` errors only. Defaults to `"info"` in development and `"warn"` otherwise (what `debug` did), and is read live. Native warnings and errors now reach the JS console outside development too.

- **iOS:** rediscovers the mesh characteristic when a peer invalidates its service (`didModifyServices`). Android rebuilds its GATT server on every mesh start while the link stays up, so the cached characteristic pointed at a dead handle and every write failed with "The handle is invalid" while the link looked ready.
- **iOS:** drops and reconnects a ready link whose write fails with an invalid handle or a missing attribute, in case the service change was never reported.
- **Both:** reading the mesh characteristic returns the device's mesh ID.
- **Android:** reads a peer's mesh ID before marking its link ready, and closes the link when this phone already has one to that device. iPhone advertisements often lack the local name carrying the ID, so an Android opened one link per rotated iPhone address; the extra setups stalled the iPhone's writes for ~20 s. The address is remembered, so its next advertisement does not connect again.
- **Android:** a link closing only fails the send in flight when that send writes to it.

## 0.2.3

Fixes 0.2.2 on Android, where links to iOS peers never became ready. Native change: needs a new development build.

- **Android:** the GATT cache is no longer cleared on every connect, only on the next connect to a peer whose writes failed with an invalid handle. Clearing it right before discovery made discovery never answer.
- **Android:** services are discovered before the MTU is requested, and the MTU is only requested when the peer did not already negotiate one on the connection (as the iPhone does when it connects to this phone's GATT server). An MTU request iOS left unanswered blocked discovery, so the link never became ready. A link is ready once the MTU settles, or after 2 s.
- **Android:** a refused or unanswered discovery (3 s) is retried up to 4 times. A link not ready 15 s after connecting is dropped.

## 0.2.2

Android links to iOS peers recover on their own instead of staying dead until Bluetooth is toggled. Native change: needs a new development build.

- **Android:** clears the cached GATT table before discovering services (iOS rebuilds its service on every mesh start, so cached handles go stale and every write failed with an invalid handle while the link looked ready).
- **Android:** drops and reconnects a link on an invalid-handle write or after 3 failed writes in a row, and one that is still not ready 10 s after connecting.
- **Android:** retries `discoverServices` when it refuses to start (another GATT operation, like the MTU request, is in flight), and logs every attempt and a missing mesh characteristic.

## 0.2.1

Diagnostic logs only: no API, wire format or behaviour change. Native changes need a new development build.

- **iOS:** warns when a mesh connection is still not ready after 10 s (CoreBluetooth's `connect` never times out), when a connection to a peer is skipped because an earlier link to it is still pending (throttled per peer), when an outbound write is still unacknowledged after 5 s, when a write exceeds the ATT MTU and goes out as a long write (`mtuPayloadLimit` is now in the send log), and when a peer cleanup fails every pending send.
- **Android:** logs MTU changes from centrals, prepared (long) write chunks, unanswered execute-write requests, and write requests received after the GATT server is gone.
- **JS:** the router warns when a direct (repair) packet reaches no link and when a write fails and the packet is dropped; sync warns when a neighbour's new request replaces an answer that is still sending, with the answer's age.

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
