# Shotgun Mesh — Architecture & Design Notes

> A BLE mesh networking SDK for Expo apps: offline, phone-to-phone message
> passing with gossip relay. This document explains **what the system is trying
> to achieve, why it is built the way it is, what we tried that failed, and
> what the known shortcomings are.** It is written to be useful both to humans
> onboarding onto the project and to LLMs asked to modify it.

---

## 1. Goal

Enable nearby phones (iOS and Android, mixed) to exchange application messages
**without any internet, Wi-Fi, or server** — using only Bluetooth Low Energy.

Design priorities, in order:

1. **Reliability** — a message either arrives intact or visibly fails.
2. **Latency** — a few-KB payload should deliver in ~1–2 s, not 10+.
3. **Cross-platform symmetry** — iPhone ↔ Android must work in both directions.
4. **Simplicity over generality** — small meshes (2–8 devices), no routing
   tables, no encryption layer (yet).

The overall approach is heavily inspired by **BitChat**: connection-oriented
GATT writes (not advertisement payloads), 512-byte packets, TTL-based gossip
flooding, and application-level fragmentation.

## 2. High-level architecture

```
┌───────────────────────────────────────────────────────────┐
│ App (examples/chat, or any Expo app)                      │
│   MeshProvider / useMesh — React API                      │
├───────────────────────────────────────────────────────────┤
│ JS mesh layer (packages/mesh/src/mesh)                    │
│   router.ts     gossip, dedup, TTL, send queue            │
│   packets.ts    packet building, fragmentation sizing     │
│   binaryWire.ts compact binary wire format                │
│   fragments.ts  reassembly of fragmented transfers        │
├───────────────────────────────────────────────────────────┤
│ Native BLE module (packages/mesh/modules/ble-broadcast)   │
│   Android: BleBroadcastModule.kt                          │
│   iOS:     BleBroadcastModule.swift                       │
│   scan + advertise + GATT client/server + serial writes   │
└───────────────────────────────────────────────────────────┘
```

Every device plays **both roles simultaneously**:

- **Peripheral** — advertises a fixed mesh service UUID (`FEED`) and runs a
  GATT server with one writable characteristic (`BEEF`).
- **Central** — scans for that UUID, connects to discovered peers, and
  delivers packets by **writing** to the peer's characteristic.

The JS↔native boundary carries **base64 strings**; the air carries raw binary.

### Data flow for one message

1. JS builds one or more `MeshSessionPacket`s (`packets.ts`).
2. Each packet is encoded to compact binary (`binaryWire.ts`), then base64.
3. Native decodes base64 and writes the raw bytes to every ready peer's
   characteristic, one ATT write at a time, waiting for each ACK.
4. The receiving GATT server reassembles any ATT-level chunks, base64-encodes,
   and emits to JS.
5. The JS router dedups by packet ID, delivers to the app, and **relays** the
   packet (TTL − 1) to all links except the one it arrived on.

## 3. Key design decisions and why

### 3.1 GATT writes, not advertisements

Advertisement payloads are ~27 bytes and unreliable for data. We advertise
**only** a service UUID for discovery; all data moves over persistent GATT
connections. This is the single most load-bearing decision — everything else
(MTU negotiation, serial writes, fragmentation) follows from it.

### 3.2 512-byte packet ceiling (`MAX_WIRE_BYTES`)

After MTU 517 negotiation, one ATT write carries 512 bytes. Early versions
sent up to 4 KB via ATT "long writes" (prepare/execute), which required
offset-based reassembly on both platforms' GATT servers and was fragile —
iOS would disconnect mid-transfer. **Lesson learned: keep every mesh packet
inside one ATT frame.** Larger payloads use application-level fragment
packets instead. The long-write reassembly code still exists on the server
side as a safety net, but the sender never relies on it.

### 3.3 Compact binary wire format

During prototyping we first used JSON-in-JSON: a session packet with five 36-char
UUID strings, base64 chunks, and a gzip envelope. For a real 2.7 KB
`syncAction` payload this produced **54 packets carrying ~51 bytes of app data
each** (~26 KB on air, 8–12 s to send). Measured breakdown: ~430 bytes of
fixed overhead per 512-byte frame.

The current binary format (`binaryWire.ts`) is the first (and only) on-wire
protocol:

- Magic `SM`, version `1`, type, flags, TTL, uint32 timestamp
- UUIDs as **16 raw bytes** instead of 36-char strings
- Fragment _continue/end_ packets carry only `transferId (16) + index (2) + raw chunk` — metadata like `messageId`/`fragmentCount` travels **only** in
  the _start_ packet
- Result: same 2.7 KB payload → **7 packets, ~400 B of data each, ~1.2 s**

Packets that do not start with the `SM` magic (or whose version byte is not 1)
are dropped. There is no decode fallback for the discarded JSON prototype.

**Gzip was removed entirely.** It caused a subtle bug: packet UUIDs
were regenerated between the fragmentation binary-search and the final encode,
so compressed size changed and packets randomly exceeded the limit
("516 bytes exceeds limit"). Stable, pre-assigned packet IDs plus binary
encoding made compression unnecessary at these sizes.

### 3.4 Serial outbound writes with ACK

Both native modules maintain a **single in-flight write** at a time, per send
operation, waiting for the ATT write ACK before the next fragment. Firing
writes concurrently caused silent drops and disconnects on both platforms.
JS-side pacing (`FRAGMENT_PUBLISH_DELAY_MS = 20`) is minimal because the
native layer already provides backpressure. An early value of 200 ms per
fragment was a major contributor to the 10-second sends.

### 3.5 Transfer quiescence

While a fragmented transfer is in flight (outbound or inbound), the router
**suppresses identity beacons and relays** (`outboundTransferDepth`,
`hasActiveTransfers()`). Before this, identity/relay traffic interleaved with
fragment writes and iOS would disconnect mid-transfer, killing 21-fragment
sends. Background traffic resumes and queued payloads flush when the
transfer completes.

### 3.6 Gossip flooding with TTL, no routing

Packets carry a TTL (`DEFAULT_TTL = 7` for messages, `IDENTITY_TTL = 4` for
beacons). Every node relays every unseen packet to all links except the
arrival link. Dedup is an in-memory set of the last 500 packet IDs. This is
deliberately dumb: for ≤8 peers, flooding is simpler and more robust than
routing. **Fragment packets are not relayed** (single-hop only) — see
shortcomings.

### 3.7 Identity as a separate concern from links

A BLE link becoming ready and knowing _who_ is on the other end are two
different events:

- `onPeerConnected` (native) → the peer appears in the UI immediately with its
  BLE device name (`isIdentified: false`).
- An **identity packet** (mesh clientId + display name) upgrades the entry
  (`isIdentified: true`) and enables sending.

We learned this separation the hard way: an earlier "fast peer list" change
used the BLE device ID as the mesh clientId, so messages were addressed to
the BLE address and the recipient **correctly dropped them** ("not addressed
to this client"). The fix: UI is keyed by stable `bleDeviceId`; routing uses
the mesh `clientId`, and sends are blocked until identity arrives. Identity
is also pushed **immediately on link-up** (plus every 5 s) rather than only
on a 15 s timer.

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

## 4. Platform-specific landmines (encountered and fixed)

These are real behaviors we hit; future changes must not regress them.

| Platform | Landmine                                                                                                                                                | Mitigation                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Android  | `onMtuChanged` may **never fire** when the peer is an iOS peripheral — gating service discovery on it deadlocks the link at "connected but never ready" | Discover services after connect on a timer; MTU callback is an optimization, not a gate |
| Android  | Responding to a GATT write _after_ emitting to JS caused write timeouts                                                                                 | **Respond first**, emit async via `mainHandler`                                         |
| Android  | Service discovery immediately after MTU change is flaky                                                                                                 | Short settle delay (50 ms)                                                              |
| Android  | Kotlin `continue` inside a `?: run {}` lambda needs Kotlin 2.2                                                                                          | Plain `if` blocks (project is on 2.1.x)                                                 |
| iOS      | Emitting to JS synchronously inside the GATT callback delayed the ATT response                                                                          | Respond, then emit async                                                                |
| iOS      | Writes >512 B via ATT long write work but are fragile                                                                                                   | Avoided entirely by the 512 B packet ceiling                                            |
| Both     | Two devices connect to each other simultaneously (dual-connect race), producing spurious connect/disconnect cycles                                      | Retry throttle (2 s); ready state only from the GATT-client side on Android             |

## 5. What works today

- iPhone ↔ Android messaging, both directions, single-packet and fragmented
- ~2.7 KB payload in 7 packets / ~1.2 s (was 54 packets / 8–12 s)
- Peer appears in the UI within ~1–3 s of both apps opening
- Correct UTF-8 everywhere (emoji, accents, device names)
- Gossip relay with dedup across ≥3 devices for non-fragmented packets
- Packaged as a reusable SDK (`@shotgun/mesh`) with a config plugin and
  React provider; chat app is just an example consumer

## 6. Known shortcomings and consciously accepted trade-offs

**No fragment relay (single-hop large payloads).** Fragment packets are
excluded from gossip relay to avoid interleaving storms. A large payload only
reaches directly-connected peers. Multi-hop large transfers would need a
store-and-forward relay of _assembled_ messages, or per-link transfer
scheduling.

**No security.** No encryption, no authentication, no replay protection
beyond the dedup window. Anyone with the UUIDs can join, read, and inject.
Fine for a demo; not fine for real ticket sales.

**No acknowledgment above the ATT layer.** Delivery is confirmed per ATT
write per link, but there is no end-to-end "message received" receipt. A peer
that drops mid-transfer loses the message; the fragment assembler times out
after 120 s.

**In-memory everything.** Dedup set, peer list, pending queue, and fragment
buffers all reset on app restart. A rejoining device re-receives whatever is
still being flooded and loses anything else.

**Small-mesh assumptions.** `maxMeshPeers = 8`; flooding cost grows with the
square of peer count; no backpressure between relays beyond a 100 ms delay.
TTL 7 is generous for 8 nodes and wasteful beyond that.

**Timestamp resolution.** The wire format stores seconds (uint32), so packet
`ts` loses millisecond precision; ordering ties are possible.

**Battery.** Continuous scanning (low-latency mode) + advertising (high TX
power) + persistent connections is expensive. Acceptable for a plugged-in POS
device; hostile to a phone in a pocket.

**Recipient IDs are advisory.** A `recipientId` filters delivery at the
receiver but the packet is still flooded to everyone — direct messages are
not private, just filtered.

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

- End-to-end message receipts + retry for fragmented transfers
- Store-and-forward relay of assembled messages for multi-hop large payloads
- Encryption (per-mesh pre-shared key would fit the POS use case)
- Persistent dedup / message store across restarts
- Advertisement-embedded short client ID for identity-before-connect
- Adaptive TTL and relay damping if mesh sizes grow past ~8 nodes

## 9. Glossary

| Term                | Meaning                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| **Packet**          | One ≤512 B wire unit (identity, message, or fragment)                        |
| **Transfer**        | A fragmented message: 1 start + N continue + 1 end packet                    |
| **Link**            | A live GATT connection to a directly-reachable peer                          |
| **Peer**            | A mesh participant, identified by mesh `clientId` (UUID)                     |
| **Identity beacon** | Periodic packet mapping `clientId` → display name                            |
| **Gossip / relay**  | Re-broadcasting unseen packets on all links except the arrival link, TTL − 1 |
| **Quiescence**      | Suppressing background traffic while a transfer is active                    |
