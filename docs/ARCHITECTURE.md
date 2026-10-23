# Shotgun Mesh — Architecture & Design Notes

> A BLE mesh networking SDK for Expo apps: an offline, phone-to-phone synced
> set of items, spread by gossip and repaired between neighbours. This document explains **what the system is trying
> to achieve, why it is built the way it is, what we tried that failed, and
> what the known shortcomings are.** It is written to be useful both to humans
> onboarding onto the project and to LLMs asked to modify it.

---

## 1. Goal

Enable nearby phones (iOS and Android, mixed) to share application data
**without any internet, Wi-Fi, or server** — using only Bluetooth Low Energy.

Design priorities, in order:

1. **Reliability** — every device of a scope ends up with every item, even
   devices that were away when it was published.
2. **Latency** — a few-KB payload should deliver in ~1–2 s, not 10+.
3. **Cross-platform symmetry** — iPhone ↔ Android must work in both directions.
4. **Simplicity over generality** — small meshes (2–8 devices), no routing
   tables, no encryption layer (yet).

The overall approach is heavily inspired by **BitChat**: connection-oriented
GATT writes (not advertisement payloads), 512-byte packets, TTL-based gossip
flooding, with larger payloads split into packet-sized parts.

## 2. High-level architecture

```
┌───────────────────────────────────────────────────────────┐
│ App (example/, or any Expo app)                           │
│   MeshProvider (syncScope, deviceKey, onItemsReceived,    │
│                 sync knobs)                               │
│   useMesh (status, peers, publishItem, addItems)          │
├───────────────────────────────────────────────────────────┤
│ Item sync (src/sync)                                      │
│   itemSync.ts   scope, persisted set, session wiring      │
│   sync.ts       push + anti-entropy repair (Trickle)      │
│   store.ts      grow-only set, version vector, digest     │
├───────────────────────────────────────────────────────────┤
│ JS mesh layer (src/mesh)                                  │
│   lifecycle.ts  Bluetooth state → start/stop, retries     │
│   router.ts     gossip, dedup, TTL, send queue            │
│   transport.ts  MeshTransport: what the router needs from │
│                 the radio (native module, or simulator)   │
│   packets.ts    packet building                           │
│   binaryWire.ts compact binary wire format                │
├───────────────────────────────────────────────────────────┤
│ Native BLE module (ios/, android/, src/native)            │
│   Android: BleBroadcastModule.kt                          │
│   iOS:     BleBroadcastModule.swift                       │
│   Bluetooth state + scan + advertise + GATT client/server │
│   + serial writes                                         │
└───────────────────────────────────────────────────────────┘
```

Every device plays **both roles simultaneously**:

- **Peripheral** — advertises a fixed mesh service UUID (`FEED`) and runs a
  GATT server with a mesh characteristic (`BEEF`): peers write packets to it,
  read it to get this device's mesh ID, and subscribe to it to receive packets
  as **notifications**. A second characteristic (`BEF0`) takes the
  subscriber's mesh ID (its "hello").
- **Central** — scans for that UUID, connects to discovered peers, and
  delivers packets by **writing** to the peer's characteristic. It also writes
  its hello and subscribes, so the peer can send back over the same link.

So two phones are usually linked twice: once each way. Native sends each
packet to a peer **once**, over this device's own link to it when that link
is ready, else as a notification over the peer's link to this device (3.11).

The JS↔native boundary carries **base64 strings**; the air carries raw binary.

### Data flow for one item

1. Sync splits the item into parts and builds one `MeshSessionPacket` per part
   (`packets.ts`).
2. Each packet is encoded to compact binary (`binaryWire.ts`), then base64.
3. Native decodes base64 and sends the raw bytes to every reachable peer once:
   a write to the peer's characteristic, one ATT write at a time waiting for
   each ACK, or a notification when only the peer's link to this device is up.
4. The receiving GATT server reassembles any ATT-level chunks, base64-encodes,
   and emits to JS.
5. The JS router dedups by packet ID, hands the part to sync (which saves the
   item once all its parts are in and passes it to the app), and **relays**
   the packet (TTL − 1) to every neighbour except the one it arrived from.

## 3. Key design decisions and why

### 3.1 GATT writes, not advertisements

Advertisement payloads are ~27 bytes and unreliable for data. We advertise
**only** a service UUID (and the device ID, 3.7) for discovery; all data moves
over persistent GATT connections: writes, and notifications back over a peer's
link (3.11). This is the single most load-bearing decision — everything else
(MTU negotiation, serial writes, splitting items into parts) follows from it.

### 3.2 512-byte packet ceiling (`MAX_WIRE_BYTES`)

After MTU 517 negotiation, one ATT write carries 512 bytes. Early versions
sent up to 4 KB via ATT "long writes" (prepare/execute), which required
offset-based reassembly on both platforms' GATT servers and was fragile —
iOS would disconnect mid-transfer. **Lesson learned: keep every mesh packet
inside one ATT frame.** Larger items travel as parts, each in its own packet
(3.10). The long-write reassembly code still exists on the server side as a
safety net, but the sender never relies on it.

### 3.3 Compact binary wire format

During prototyping we first used JSON-in-JSON: a session packet with five 36-char
UUID strings, base64 chunks, and a gzip envelope. For a real 2.7 KB
`syncAction` payload this produced **54 packets carrying ~51 bytes of app data
each** (~26 KB on air, 8–12 s to send). Measured breakdown: ~430 bytes of
fixed overhead per 512-byte frame.

The current binary format (`binaryWire.ts`) is the first (and only) on-wire
protocol:

- Magic `SM`, version `1`, type, flags, TTL, uint32 timestamp
- Sender and recipient as **4-byte device IDs** (see 3.7); packet IDs as
  **16 raw UUID bytes** instead of 36-char strings
- Types: identity, item parts, and the three repair packets (digest, version
  vector, request); sync packets start with a 4-byte scope hash
- Result: the same 2.7 KB payload now takes **7 packets of ~440 B of data**

Packets that do not start with the `SM` magic (or whose version byte is not 1)
are dropped. There is no decode fallback for the discarded JSON prototype.

**Gzip was removed entirely.** It caused a subtle bug: packet UUIDs
were regenerated between the (since removed) fragment sizing search and the final encode,
so compressed size changed and packets randomly exceeded the limit
("516 bytes exceeds limit"). Stable, pre-assigned packet IDs plus binary
encoding made compression unnecessary at these sizes.

### 3.4 Serial outbound writes with ACK

Both native modules maintain a **single in-flight write** at a time, per send
operation, waiting for the ATT write ACK before the next write. Notifications
(3.11) have no ACK; they are paced by the platform instead. Firing
writes concurrently caused silent drops and disconnects on both platforms.
Link-local sync writes get no JS pacing on top: the native layer already
provides backpressure. (An early 200 ms delay between packets was the main
cost of 10-second sends.) Relays queued while a send is in progress go out
100 ms apart, at most 100 waiting (oldest dropped). This device's own item
parts are not paced and have their own cap of 1,000: a publish queues all of an
item's parts at once (a photo in the example app is ~270), and the old shared
cap of 100 dropped most of them while the 100 ms pacing alone took ~30 s. In the
simulator this converges a 40-item burst in 18 s instead of 24 s; without
repair, the faster pushes overflow neighbours' relay queues (59 of 117 burst
items lost), which repair recovers as soon as it is on. A relay cap of 300 loses
nothing then but costs ~20–30% more writes per item with repair on, so it stays
at 100.

### 3.5 Item parts instead of transfers

Earlier versions sent large messages as fragmented "transfers" (start,
continue, end packets) that were never relayed, and paused beacons and relays
while one was in flight, because interleaved traffic made iOS disconnect
mid-transfer. Items replaced messages: an item part is an ordinary packet,
relayed like any other, reassembled by whoever receives all of its parts, and
a missing part is fetched again by repair. Nothing pauses background traffic
any more.

### 3.6 Gossip flooding with TTL, no routing

Packets carry a TTL (`pushHops`, default 7, for fresh items;
`IDENTITY_TTL = 4` for beacons; 0 for link-local repair traffic). Every node relays every unseen packet to every neighbour
except the one it arrived from (native resolves the arrival link to its peer, so
neither of that peer's links gets it back). Dedup is an in-memory set of the last 500 packet IDs. This is
deliberately dumb: for ≤8 peers, flooding is simpler and more robust than
routing.

### 3.7 Identity: one device ID per install

Every install generates a random **device ID** once (`DEVICE_ID_BYTES` = 4
bytes, 8 hex chars), stored natively outside backups (`noBackupFilesDir` on
Android, Application Support excluded from backup on iOS) so restoring a
backup onto a new phone does not clone it. It is the sender and recipient in
every packet header and the key of the peer list.

**Or derived from the app's own ID.** An app that already has a per-install ID
(one its server knows) passes it as `deviceKey`; the device ID is then its
32-bit FNV-1a hash (`deviceIdFromKey`), the same hash as scope hashes. Every
item the device publishes is authored by that ID, so the app's server can
store only an item's `seq` next to its own row and still name the mesh item:
`addItems` re-derives the author from the row's device key. Changing the key
restarts the session under the new ID.

**Why 4 bytes.** The mesh targets an event-sized group (up to ~100 devices).
A collision is not cosmetic: a device drops every packet carrying its own ID
as an echo of itself. With 2 bytes, 100 devices collide in ~7% of events; with
4 bytes, about one in 800,000.

**The ID is in the advertisement.** Android advertises it as service data on
the mesh service; iOS cannot advertise service data, so it puts it in the
local name (`SM:<id>`). The native layer skips a second connection to a device
it already has a link to (phones rotate their address, so one phone shows up
under several identifiers). A link still setting up after 5 s gives way to the
same device seen under a new identifier instead (3.11).

**Android also reads it before a link is ready.** Android receives iPhone
advertisements without the local name, so it cannot tell a rotated iPhone
address from a new phone. Before marking a link ready, the Android central
reads the mesh characteristic, which returns the peer's mesh ID. A link to a
device it already has a link to is closed there, and the address is remembered
so its next advertisement does not connect again. Either way,
`onPeerConnected` carries the peer's `meshId`.

**Why the BLE link identifier cannot be the identity.** We learned this twice:

- An early "fast peer list" used the BLE device ID as the mesh client ID, so
  messages were addressed to the BLE address and the recipient **correctly
  dropped them** ("not addressed to this client").
- Keying the peer list by link identifier produced duplicate rows: iOS sees an
  Android phone under one identifier when it connects to it and another when
  the phone connects back, and Android picks a new address when Bluetooth
  restarts. An anonymous "Connecting…" row could never be matched to the
  identity that arrived on the other identifier.

**Peer list.** Keyed only by device ID. Identity packets set the announced name
(the device name unless the app set one), link events the BLE name and RSSI.
A link whose advertisement lacked the ID (iOS apps in the background drop the
local name) adds nothing; the peer appears when its identity packet arrives,
which is pushed **immediately on link-up** (plus every 5 s). A peer is removed
when its last link, in either direction, disconnects: the router counts links
per device ID and reports a neighbour up on its first link and down on its
last, for the peer list and for sync alike.

### 3.8 Base64 at the JS↔native bridge

Expo module functions pass strings. Binary wire packets are base64-encoded in
JS, decoded to raw bytes in native before hitting the air, and re-encoded on
receive. The earlier code passed the payload as a UTF-8 string
(`jsonMessage.toByteArray(UTF_8)`), which corrupts arbitrary binary.

**War story:** the first base64 implementation was hand-rolled and mishandled
`=` padding — **341 of 512 possible packet lengths corrupted their final
byte(s)**. Symptom: "Galaxy A22 5G" rendered as "Galaxy A22 5®". Fix: use
standard `atob`/`btoa`, and truncate UTF-8 strings on **code-point
boundaries** (`truncateUtf8ToBytes`), never on JS string length.
**Lesson: never hand-roll base64.**

### 3.9 The provider owns the lifecycle

Apps never call start or stop. Mounting `MeshProvider` creates a `MeshLifecycle`
(`lifecycle.ts`) that keeps the mesh running whenever Bluetooth allows it.

**Native reports one Bluetooth state.** `getBluetoothStateAsync()` returns
`poweredOn | poweredOff | unauthorized | unsupported | unknown` (CoreBluetooth's
names), folding permission, power, and hardware support into one value, and
`onBluetoothStateChange` fires when it changes:

- **iOS** combines the states of the peripheral and central managers (the mesh
  needs both roles). The managers are created lazily, on the first state read,
  so the permission prompt appears when the provider mounts rather than at app
  launch. `unknown` covers the time the prompt is on screen. Both
  managers opt out of the system "Turn On Bluetooth" alert: Bluetooth being off
  only shows up as `poweredOff`, and the app decides what to show.
- **Android** checks `FEATURE_BLUETOOTH_LE`, the runtime permissions, the
  adapter state, and that the LE advertiser exists (peripheral mode), and
  listens to `ACTION_STATE_CHANGED`. Permission changes have no broadcast;
  revoking one kills the app, and granting one is picked up by the foreground
  refresh below.

**JS turns the state into a status.** The lifecycle re-reads the state on
mount, on every `onBluetoothStateChange`, and when the app returns to the
foreground. `poweredOn` starts the session (router first, so it is listening
before the first peer connects, then advertising, then scanning); anything else
stops it and maps to `bluetooth_off`, `permission_denied`, `unsupported`, or
`starting` (for `unknown`). On Android, an `unauthorized` state triggers the
permission dialog once per app launch.

**Retries.** A failed start is retried after 1 s, then 2 s. After 3 failures in
a row the status is `error`, with the last native error message. Any later
Bluetooth state change or app foregrounding starts a new round of 3 attempts, so
`error` is never a dead end.

**One operation queue for the whole app.** The native module is a singleton, so
every refresh, start, and stop goes through one module-level promise queue
shared by all lifecycle instances. A provider that unmounts (including React
StrictMode's mount → unmount → mount) finishes stopping before the next one
starts. Callbacks from a router that was already stopped are ignored.

**Power-off is handled natively first.** When Bluetooth stops being usable, the
native module drops its own runtime state (advertising, scanning, GATT server,
peer links, in-flight writes) and emits `onPeerDisconnected` for every peer,
then JS stops the router. CoreBluetooth does not call the disconnect delegate
when it powers off, so JS cannot rely on per-peer events here.

**Identity and items survive restarts.** The device ID is per install, and
items are saved per scope, so a Bluetooth toggle or an app restart neither
changes who this device is nor delivers an item to the app twice.

**Silent failures are caught on refresh.** If Bluetooth resets and comes back
before the queued refresh runs, the state read is `poweredOn` again while the
native runtime was wiped. Every refresh with a running session therefore also
checks `isBroadcastingAsync`/`isScanningAsync` and restarts the session if
either is false.

**Renaming.** Identity beacons reuse one packet ID per session (so each node
relays a beacon only once), which means peers would drop a renamed beacon as a
duplicate. `setDisplayName` gives the identity a new packet ID and publishes it
immediately. Only identity packets carry the name, so the peer list keeps a
peer's announced name when chat or link events arrive without one.

### 3.10 Item sync: push, then repair

The app does not send messages; it publishes **items** into a replicated,
grow-only set (one set per **scope**, e.g. an event). An item is
`(author, seq, createdAt, data)`: `author` is the publishing device's ID and
`seq` a per-device counter with no gaps, so `(author, seq)` identifies it and
"what do I have" is a version vector `{author: highest contiguous seq}`.

- **Push.** A published item floods the mesh once (`pushHops`, default 7), as
  `syncItems` packets. Items over one packet travel as parts (up to 4 KB),
  each part flooded like any packet and reassembled by the receiver.
- **Repair (anti-entropy).** Flooding alone loses items for good: a device
  that was off, out of range, or linked a second too late never sees them
  again (the simulator measured this even in a perfect lab). So each device
  beacons a digest of its set (XOR of item hashes + count) to its direct
  neighbours on a Trickle timer: every second after a change, backing off to
  16 s while neighbours agree. Two differing digests in a row from a neighbour
  start an exchange of version vectors, and each side asks the other for the
  seqs it misses past its contiguous prefix, as `(author, from…to)` ranges that
  skip seqs it already holds (seeded sets have gaps). A new link starts an
  exchange at once, and so does a new sync instance (scope switch, set loaded):
  it greets every neighbour whose link is already up.
- **Seeding and the repair gate.** An app that also syncs through a server
  hands the server's copies to `addItems`: they join the set (saved, served to
  neighbours, neither flooded nor delivered) and repair stops asking for them.
  To keep a phone that just switched to a big event from fetching its whole
  history over Bluetooth, the app holds `repair` off until its server pull has
  caught up. Pushes flow meanwhile. Turning `repair` back on compares with every
  neighbour at once (`compareNow`) rather than at the next beacons, which can be
  16 s apart once idle.
- **Link-local traffic.** Digests, vectors, requests and answers have TTL 0
  (never relayed). Vectors, requests and answers are addressed to one
  neighbour: `sendPacketAsync` takes a target mesh ID, matched against each
  route's mesh ID (3.11). When no link carries it (an iOS peer advertising in
  the background), the packet goes to every neighbour and its recipient ID
  makes the others ignore it. Link-local packets bypass the relay queue and
  its pacing; an answer goes out one packet at a time, and a newer request
  from the same neighbour replaces what is left of an older answer.
- **Scope.** Every sync packet carries a hash of the scope; devices ignore
  other scopes, so phones on different events never mix their sets. A scope
  switch stops the old sync instance with its neighbour state, pending answers,
  request rounds and timers, so nothing of the old scope goes out afterwards.
  `syncScope = null` turns sync off: no set, no beacons, every sync packet
  ignored; the router still relays other devices' floods.
- **Persistence.** The native module keeps one append-only file of JSON lines
  per scope (`expo-mesh-items/`, excluded from backups like the device ID).
  Received items are saved, then handed to the app (`onItemsReceived`), so the
  app sees each item once across restarts and needs no outbox of its own.
  `clearMeshItems()` rewrites every file (atomically) down to one line of
  `seqFloors`, the highest seq per author it held: on load the device reserves
  its own floor, so its next item never reuses a seq that peers may hold.
- **Knobs.** `repair`, `pushHops`, the two digest intervals and
  `maxItemsPerRequest` are `MeshProvider` props read live, so an app can tune
  them without a library release. `simulator/` measures them (`pnpm sim:bench`).

### 3.11 Links in both directions, one route per peer

Each phone connects to the other as a central, so a pair is usually linked
twice. Until 0.4.0 a phone could only send over the link **it** opened. When
that link never came up, the phone was mute towards that peer even though the
peer's link to it worked: an iPhone's connect to an Android address that had
since rotated stayed pending for minutes (CoreBluetooth's `connect` never times
out), so the iPhone sent nothing, the Android never got its identity packet,
and it listed the iPhone under its short ID.

**Notifications make either link enough.** A central, once it found the mesh
characteristic, writes its mesh ID to the hello characteristic and subscribes
to the mesh characteristic. The peripheral keeps each subscription as an
**inbound link**, known by peer from the hello (the hello comes first; if it
arrives late, the link is reported again with its ID). Native then builds one
**route** per peer (by mesh ID) from both kinds of links and sends each packet
once per route:

- over the **outbound** link (this device's own) when it is ready: writes are
  acknowledged, and it is the path every earlier version proved;
- else as a **notification** on the inbound link. A notification is one ATT
  packet, so a packet larger than the subscriber's MTU − 3 is skipped
  (`skippedTooLarge`) and reaches that peer once a link that can carry it is
  up. Android centrals request MTU 517, so mesh packets usually fit.

Notifications have no ATT acknowledgement (the link layer still retransmits),
and flow control is per platform: iOS's `updateValue` refuses a packet while
CoreBluetooth's queue is full, and the rest wait for
`peripheralManagerIsReady(toUpdateSubscribers:)`; Android's server takes one
notification at a time, the next after `onNotificationSent` (or 2 s). Both
queue at most 64 and drop the oldest.

`getConnectedPeerCountAsync` and `readyPeerCount` count routes, not links, and
link events carry a `direction` (`outbound` / `inbound`) because an outbound
and an inbound link can share a BLE identifier on Android. An inbound link has
no RSSI of its own: its event carries the last RSSI seen in that peer's
advertisement.

**Link setup is bounded.** The research behind this (bitchat, Herald, Google
Nearby, Meshtastic all cancel a pending connect after 8–12 s; Berty's iOS driver
does not and has this exact bug) gave two rules:

- **Timeout.** iOS drops a link not ready 10 s after its connect (or after a
  rediscovery started) and cancels the connection. Android drops one not
  connected after 10 s and one connected but not ready after 15 s.
- **A new identifier replaces a stuck link.** When the same mesh ID shows up
  under another identifier while the link to it is still setting up after 5 s,
  the old link is dropped and the new identifier connects. Apple: a device
  using a rotating address must be rediscovered. A ready link is never replaced.

## 4. Platform-specific landmines (encountered and fixed)

These are real behaviors we hit; future changes must not regress them.

| Platform | Landmine                                                                                                                                                | Mitigation                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Android  | `onMtuChanged` may **never fire** when the peer is an iOS peripheral — gating service discovery on it deadlocks the link at "connected but never ready" | Discover services before requesting the MTU; never gate readiness on `onMtuChanged` alone |
| Android  | Responding to a GATT write _after_ emitting to JS caused write timeouts                                                                                 | **Respond first**, emit async via `mainHandler`                                         |
| Android  | Service discovery immediately after MTU change is flaky                                                                                                 | Short settle delay (50 ms)                                                              |
| Android  | The GATT table of an iOS peer is cached per address, but iOS rebuilds its service on every mesh start: writes then fail with an invalid handle (status 1) while the link still looks ready | Drop the link on an invalid handle or 3 failed writes in a row, and clear that peer's cache (`BluetoothGatt.refresh()`, hidden) on its next connect. Never refresh right before discovering: discovery then gets no answer |
| Android  | iOS can leave the Android client's MTU request unanswered (the iPhone already negotiated the MTU of the shared connection as a central); every GATT operation behind it, discovery included, then waits, and the link stays "connected but never ready" | Discover first; request the MTU only when the GATT server has not seen one for that device, and mark the link ready after the MTU settles or 2 s. Retry a refused or unanswered discovery (3 s) up to 4 times; drop a link not ready 15 s after connecting |
| Android  | Kotlin `continue` inside a `?: run {}` lambda needs Kotlin 2.2                                                                                          | Plain `if` blocks (project is on 2.1.x)                                                 |
| iOS      | Emitting to JS synchronously inside the GATT callback delayed the ATT response                                                                          | Respond, then emit async                                                                |
| iOS      | Writes >512 B via ATT long write work but are fragile                                                                                                   | Avoided entirely by the 512 B packet ceiling                                            |
| Both     | Two devices connect to each other simultaneously (dual-connect race), producing spurious connect/disconnect cycles                                      | Retry throttle (2 s); ready state only from the GATT-client side on Android             |
| iOS      | Powering off invalidates every peripheral without calling `didDisconnectPeripheral`, stops advertising, and clears the GATT database                    | Reset all runtime state on any non-`poweredOn` state; emit disconnects ourselves        |
| iOS      | `stopScan`, `stopAdvertising`, `cancelPeripheralConnection` while not powered on log "API MISUSE"                                                       | Only call them when the manager is `poweredOn`                                          |
| iOS      | The start promise resolved when the service was added, so an advertising failure was silent                                                             | Resolve in `peripheralManagerDidStartAdvertising`                                       |
| Android  | `stopScan` and `stopAdvertising` throw `IllegalStateException` once the adapter is off                                                                  | Wrap them in `runCatching`                                                              |
| Both     | Identity beacons reuse one packet ID, so peers drop a renamed beacon as already seen                                                                    | New identity packet ID on every rename                                                  |
| Both     | One phone appears under several BLE identifiers (per role on iOS, address rotation on Android)                                                          | Device ID in the advertisement; peers keyed by it; one link per device ID               |
| Android  | iPhone advertisements often arrive without the local name (`SM:<id>`), so an Android connected to one iPhone once per rotated address (3 links seen); the extra connection setups stalled the iPhone's writes to it for ~20 s | Read the mesh ID from the characteristic before a link is ready; close a link to an already linked device and remember its address |
| iOS      | CoreBluetooth's `connect` never times out; an Android peer that rotated its address never answers on the old one, and that pending link blocked every connection to the peer's new identifiers (same mesh ID): the iPhone could not send to it for minutes | Drop a link not ready 10 s after its connect; a link still setting up gives way to the peer's new identifier after 5 s; notifications let the peer's own link carry this device's packets meanwhile (3.11) |
| Android  | Before Android 13, notifications arrive in the deprecated `onCharacteristicChanged(gatt, characteristic)`, whose `characteristic.value` the next notification overwrites | Copy the value inside the callback, before posting it to the main thread |
| Android  | A GATT server sends one notification at a time; the next before `onNotificationSent` is refused | Queue notifications; send the next on `onNotificationSent`, or after 2 s without it |
| iOS      | Two apps embedding the mesh on one iPhone (e.g. a dev and a staging build) both publish the mesh service: iOS merges every app's services into one GATT table, so a peer can write to the **other** app. Writes succeed (status 0 on Android) yet the foreground app logs no `Accumulated ATT write fragment`; looks like random lost items, a ghost duplicate iPhone, or a Bluetooth toggle "fixing" it | When an iPhone acks writes it never logs, force-quit or delete every other build that embeds the mesh before debugging anything else |

## 5. What works today

- iPhone ↔ Android exchange, both directions (proven with the earlier
  message protocol: ~2.7 KB in 7 packets / ~1.2 s, was 54 packets / 8–12 s)
- Peer appears in the UI within ~1–3 s of both apps opening
- Correct UTF-8 everywhere (emoji, accents, device names)
- Gossip relay with dedup across ≥3 devices
- Packaged as a reusable SDK (`@shotgunlive/mesh`) with a config plugin and
  React provider; chat app is just an example consumer
- Item sync (push + repair, per-scope persistence): measured in the simulator
  (`simulator/`), which runs this code on virtual phones; not yet exercised on
  real phones
- Hands-off lifecycle: wrapping the app in `MeshProvider` is enough; the mesh
  follows Bluetooth permission and power state on its own and reports it as a
  status

## 6. Known shortcomings and consciously accepted trade-offs

**No security.** No encryption, no authentication, no replay protection
beyond the dedup window. Anyone with the UUIDs can join, read, and inject.
Fine for a demo; not fine for real ticket sales.

**No acknowledgment above the ATT layer, by design.** Delivery is confirmed
per ATT write per link (notifications, used when only the peer's link is up,
are not acknowledged even there); there is no end-to-end receipt. Repair replaces it:
neighbours keep comparing sets and re-send what is missing, so an item a
device missed (a lost part, a link dropped mid-flood) arrives later instead
of being lost.

**In-memory routing state.** Dedup set, peer list, pending queue and partly
received items reset on app restart. Items do not: they are saved, and repair fetches
whatever a device missed.

**Small-mesh assumptions.** `maxMeshPeers = 8`; flooding cost grows with the
square of peer count; no backpressure between relays beyond a 100 ms delay.
TTL 7 is generous for 8 nodes and wasteful beyond that.

**Timestamp resolution.** The wire format stores seconds (uint32), so packet
`ts` loses millisecond precision; ordering ties are possible.

**Battery.** Continuous scanning (low-latency mode) + advertising (high TX
power) + persistent connections is expensive. Acceptable for a plugged-in POS
device; hostile to a phone in a pocket.

**Recipient IDs are advisory.** A sync packet addressed to one neighbour goes
to every neighbour when the target's link is unknown; the others ignore it,
but it is not private.

## 7. Failed approaches (do not retry without new evidence)

1. **Large single GATT payloads (up to 4 KB long writes)** — fragile,
   platform-dependent, iOS disconnects mid-write. Replaced by ≤512 B packets.
2. **JSON wire format with gzip** — 8× overhead on real payloads, plus
   non-deterministic size when packet IDs were regenerated after sizing.
3. **Hand-rolled base64** — corrupted padding on most lengths.
4. **Gating Android service discovery on** `onMtuChanged` — deadlocks against
   iOS peripherals.
5. **Using the BLE device ID as the mesh client ID** — broke recipient
   addressing.
6. **Legacy fallback in the router queue that dropped** `excludeDeviceId` —
   caused relays to bounce back to their sender. Explicitly removed; do not
   re-add.
7. **200 ms pacing between fragments** — unnecessary given native ACK-based
   backpressure; was the dominant latency cost.

## 8. Likely next steps

- Encryption (per-mesh pre-shared key would fit the POS use case)
- Pruning old scopes from disk (each event's item file stays on the device)
- Carrying the set digest in identity beacons instead of a separate beacon
- Liveness for peers several hops away: they are only removed when the mesh
  stops, because their repeated beacons are deduplicated before anyone sees
  them (rotating the beacon packet ID every ~30 s would fix it)
- Adaptive TTL and relay damping if mesh sizes grow past ~8 nodes

## 9. Glossary

| Term                | Meaning                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| **Packet**          | One ≤512 B wire unit (identity, item part, or repair packet)                 |
| **Part**            | A slice of an item's data (≤440 B) that fits one packet                      |
| **Link**            | A GATT connection to a direct neighbour: outbound (this device connected and writes) or inbound (the peer connected and subscribed; this device notifies) |
| **Route**           | One peer as native sends to it: its outbound link if ready, else its inbound link |
| **Peer**            | A mesh participant, identified by its 4-byte device ID                       |
| **Identity beacon** | Periodic packet mapping device ID → display name                             |
| **Gossip / relay**  | Re-broadcasting unseen packets to every neighbour except the sender's, TTL − 1 |
| **Item**            | One element of the synced set: `(author, seq, createdAt, data)`              |
| **Scope**           | Which set a device syncs (e.g. an event); other scopes are ignored           |
| **Version vector**  | Per author, the highest seq held with no gap below it                        |
| **Repair**          | Neighbours comparing digests and vectors, then fetching missing ranges       |
