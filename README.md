# @shotgunlive/mesh

BLE mesh networking SDK for Expo apps: a native Bluetooth LE module (iOS + Android), a mesh router, and a React API.

Read **[docs/ARCHITECTURE.md](https://github.com/shotgun-warehouse/mesh/blob/main/docs/ARCHITECTURE.md)** for the design rationale: what the mesh is trying to achieve, why it uses GATT writes with a 512-byte binary wire format, what approaches failed along the way, and the known trade-offs.

## Install

```sh
npx expo install @shotgunlive/mesh expo-dev-client
```

Add the config plugin:

```ts
// app.config.ts
plugins: ["@shotgunlive/mesh"];
```

It declares the Android Bluetooth permissions and the `bluetooth_le` feature, and sets a default iOS Bluetooth permission text (`NSBluetoothAlwaysUsageDescription`). To use your own text, set it in `ios.infoPlist`.

Optional, iOS: to keep the mesh reachable while the app is in the background, add the Bluetooth background mode:

```ts
// app.config.ts
ios: {
  infoPlist: {
    UIBackgroundModes: ["bluetooth-peripheral"],
  },
},
```

The native module is autolinked. It needs a development build (`npx expo prebuild` / EAS Build); it does not run in Expo Go.

## Usage

Wrap your app in `MeshProvider`. There is nothing to start or stop: the provider asks for Bluetooth permission, starts the mesh as soon as Bluetooth is usable, stops it when Bluetooth is turned off, and starts it again when Bluetooth comes back or the app returns to the foreground.

The mesh keeps a **synced set of items** on every device: publish an item on one phone and it reaches every phone of the same scope, including phones that were off, out of range or not installed yet when it was published. The library saves the set on the device, deduplicates, queues while there are no peers and repairs gaps with its neighbours; the app only publishes, and handles what it receives.

```tsx
import { MeshProvider, useMesh } from "@shotgunlive/mesh";

export default function App() {
  return (
    <MeshProvider
      syncScope={String(eventId)}
      onItemsReceived={(items) => {
        for (const item of items) {
          saveScan(JSON.parse(item.data)); // each item once, already saved by the library
        }
      }}
    >
      <ScanScreen />
    </MeshProvider>
  );
}

function ScanScreen() {
  const { publishItem } = useMesh();
  // on scan:
  // await publishItem(JSON.stringify(scan));
}
```

Mount a single `MeshProvider`, near the root: there is one Bluetooth radio. The permission prompt appears when the provider mounts, so mount it where you want the prompt to show.

### Status

`useMesh().status` is one of:

| Status              | Meaning                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starting`          | Bluetooth is usable (or the user is answering the permission prompt) and the mesh is starting.                                                             |
| `running`           | The mesh is up. Items spread to peers.                                                                                                                     |
| `bluetooth_off`     | Bluetooth is turned off. iOS shows no system alert for it, so tell the user yourself. The mesh starts by itself once it is turned on.                      |
| `permission_denied` | The user denied Bluetooth permission. Send them to Settings (`Linking.openSettings()`); the mesh starts when they come back with it granted.               |
| `unsupported`       | The device has no Bluetooth LE, or cannot advertise (for example the iOS Simulator).                                                                       |
| `error`             | The mesh failed to start 3 times in a row (retrying after 1 s, then 2 s). `useMesh().error` says why. Toggling Bluetooth or reopening the app tries again. |

On Android the permission dialog is shown once per app launch; after a denial, the user grants the permission in Settings.

Items can be published in any status: they are saved and spread once peers are around.

### Publishing

`publishItem(data)` adds an item to the set and resolves with it once it is saved: `{ author, seq, createdAt, data }`, where `author` is this device's ID and `seq` its per-device counter. `data` is a string (usually JSON) of at most 4 KB of UTF-8; larger data rejects. The item floods the mesh right away when peers are connected; devices that miss the flood get it from a neighbour later.

### Receiving

`onItemsReceived(items)` is called with items published on other devices, the first time each reaches this one. The library has already saved them, so each item comes once, across restarts too (only an item that arrives just as the app is killed, before its save lands, can come again). It is never called with this device's own items.

### Scopes

`syncScope` (required) picks the set this device works on, for example the current event ID. Items are saved per scope, and devices only sync with devices on the same scope, so phones working different events never mix their data: every sync packet carries a hash of the scope, and devices ignore other scopes. Changing `syncScope` switches sets; the old one stays saved on the device, and nothing of it is sent after the switch.

`syncScope={null}` turns sync off, for example before the user picks an event: no set is loaded, `publishItem` and `addItems` reject, and nothing is received. The mesh itself keeps running (peers are listed) and still relays other devices' items.

### Seeding from your server

If your app also syncs items through a server, a phone that joins a busy scope would otherwise fetch its whole history over Bluetooth. Instead:

1. Pass your own per-install ID as `deviceKey`. The mesh device ID is derived from it, so every item this phone publishes is authored by it. Store each item's `seq` (from `publishItem`) next to your server row, which already knows the device's key.
2. After each server pull, hand the rows to `addItems(scope, [{ deviceKey, seq, createdAt, data }])`. They join the set without being flooded or passed to `onItemsReceived`, and repair stops asking neighbours for them; it only fetches the items the server does not have. Encode `data` the same way as when publishing, so neighbours this phone serves decode the same item.
3. Hold `sync.repair` off while the pull catches up after a scope switch, then turn it on. Pushes keep flowing meanwhile. Turning repair on compares with every neighbour right away instead of waiting for the next beacons.

`addItems` rejects when `scope` is not the current `syncScope` (a pull for the previous event landing after a switch), including when the scope changes while it waits for the set to load. It works in any status and with repair off.

### Clearing storage

`clearMeshItems()` deletes every synced item this device holds, in every scope (for example on logout). It works with or without a mounted `MeshProvider`; a mounted one keeps running on an emptied set, and repair fetches back what neighbours of the current scope still hold. Items published while it runs are kept.

The device keeps numbering its own items after the deleted ones (the library keeps their highest `seq` per scope, a few bytes), so peers that still hold them never take a new item for an old one.

### Sync knobs

`sync` tunes how items spread. It is read live, so changing it takes effect without a restart (and without a library release). Omitted fields keep their defaults.

| Knob                  | Default | Description                                                                                                                                                                                                                                                                         |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repair`              | `true`  | Compare with neighbours and fetch what is missing. Off, each item is flooded once and devices that were not reachable then never get it. Hold it off while your server catch-up runs (see [Seeding](#seeding-from-your-server)); turning it on compares with neighbours right away. |
| `pushHops`            | `7`     | Hops a freshly published item floods. Lower saves airtime on large items; repair then carries them further, more slowly.                                                                                                                                                            |
| `minDigestIntervalMs` | `1000`  | How often a device announces a summary of its set right after a change.                                                                                                                                                                                                             |
| `maxDigestIntervalMs` | `16000` | How often it does once its neighbours agree. Lower finds gaps sooner, at the cost of more beacons.                                                                                                                                                                                  |
| `maxItemsPerRequest`  | `40`    | Items asked from one neighbour per round; the next round starts when it lands.                                                                                                                                                                                                      |

The [simulator](simulator/SPEC.md) shows what each knob does: Compare mode runs the same venue with two sets of knobs side by side, and `pnpm sim:bench` measures them on the scenarios in `simulator/scenarios/`.

### Peers

Each device has a device ID, generated once per install and kept across app restarts and Bluetooth toggles (it is not restored from backups, so two phones never share one). It is in every packet and in the Bluetooth advertisement, so a device is listed once, under that ID, from the moment it connects. Its `displayName` is the name it announces, which is its device name ("Galaxy A22 5G") unless that app set another. A peer leaves the list when its last direct link drops.

### Display name

Nearby devices see this device under its display name, which defaults to the device name. On iOS 16 and later, apps only get a generic name ("iPhone") unless they have the user-assigned device name entitlement, so you will usually want to set your own: pass `displayName` to `MeshProvider`, or call `setDisplayName` from `useMesh()`. Peers see a new name within seconds.

### API

`MeshProvider` props (all optional but `syncScope`):

| Prop              | Default                        | Description                                                                                                                                     |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `syncScope`       | required                       | The item set to sync, or `null` for none. See [Scopes](#scopes).                                                                                |
| `deviceKey`       | none                           | Your per-install ID; the device ID is derived from it. Must stay stable per install and not be blank. See [Seeding](#seeding-from-your-server). |
| `onItemsReceived` | none                           | Items from other devices, each once. See [Receiving](#receiving).                                                                               |
| `sync`            | library defaults               | Sync knobs. See [Sync knobs](#sync-knobs).                                                                                                      |
| `displayName`     | the device name                | Name nearby devices see. Changing it renames the device, like `setDisplayName`.                                                                 |
| `logLevel`        | `"info"` in dev, else `"warn"` | Least severe JS and native logs printed: `"info"` (all), `"warn"` (warnings and errors) or `"error"`. Read live.                                |

`useMesh()` returns:

| Field                    | Description                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `status`                 | See [Status](#status).                                                                                                   |
| `error`                  | Why the mesh could not start, when `status` is `error`; otherwise `null`.                                                |
| `publishItem(data)`      | See [Publishing](#publishing). Rejects when `syncScope` is `null`.                                                       |
| `addItems(scope, items)` | Seeds the set with items from your server. See [Seeding](#seeding-from-your-server).                                     |
| `peers`                  | Devices on the mesh, most recently active first: `{ id, displayName, deviceName, rssi, lastSeen }`. See [Peers](#peers). |
| `connectedPeerCount`     | Number of direct Bluetooth links.                                                                                        |
| `getPeer(peerId)`        | A peer by its device ID.                                                                                                 |
| `deviceId`               | This device's ID: 8 hex chars, derived from `deviceKey` or generated once per install. Peers see it as `peer.id`.        |
| `displayName`            | This device's display name.                                                                                              |
| `setDisplayName(name)`   | Renames this device on the mesh. Blank names are ignored.                                                                |

`clearMeshItems()` deletes the stored items. See [Clearing storage](#clearing-storage).

The package exports `MeshProvider`, `useMesh`, `clearMeshItems` and the `MeshItem` type.

## Repository layout

```
src/          TypeScript SDK (mesh router, React API, native module bindings in src/native)
ios/          Native module, iOS (Swift)
android/      Native module, Android (Kotlin)
plugin/       Expo config plugin
example/      Chat example app (not published)
simulator/    Browser playground and headless bench running the real router on virtual phones (not published)
```

## Example app

```sh
pnpm install           # at the repo root: installs the SDK and the example, builds the SDK + config plugin
cd example
pnpm prebuild
pnpm ios               # or pnpm android
pnpm start
```

The example's Metro config resolves `@shotgunlive/mesh` to `../src`, so JS changes to the SDK show up without a rebuild. Changes to the config plugin need `pnpm build` at the root, then `pnpm prebuild` in the example.

The repo is a pnpm workspace only so the example and the simulator share the SDK's dependencies (one copy of React and Expo); the published package is the repo root.

## Simulator

`pnpm sim` opens a browser playground that runs the real `MeshRouter` on dozens of virtual phones over a simulated BLE medium: place devices, cut links, partition the venue, kill apps, and compare sync strategies. `pnpm sim:test` and `pnpm sim:bench` run it headless. See [simulator/SPEC.md](simulator/SPEC.md).

## Releasing

Publishing is done by [.github/workflows/release.yml](https://github.com/shotgun-warehouse/mesh/blob/main/.github/workflows/release.yml) when a `v*` tag is pushed:

1. Bump `version` in `package.json` and add an entry to [CHANGELOG.md](https://github.com/shotgun-warehouse/mesh/blob/main/CHANGELOG.md).
2. Merge to `main`, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.

The workflow checks that the tag matches the package version, builds, and publishes with provenance via npm trusted publishing (no token). Pre-release versions (`0.2.0-beta.1`) are published under the `next` dist-tag.
