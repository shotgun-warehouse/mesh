# @shotgun/mesh

BLE mesh networking SDK for Expo apps: a native Bluetooth LE module (iOS + Android), a mesh router, and a React API.

Read **[docs/ARCHITECTURE.md](https://github.com/shotgun-warehouse/mesh/blob/main/docs/ARCHITECTURE.md)** for the design rationale: what the mesh is trying to achieve, why it uses GATT writes with a 512-byte binary wire format, what approaches failed along the way, and the known trade-offs.

## Install

```sh
npx expo install @shotgun/mesh expo-dev-client
```

Add the config plugin:

```ts
// app.config.ts
plugins: ["@shotgun/mesh"];
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

```tsx
import { MeshProvider, useMesh, useMeshMessages } from "@shotgun/mesh";

export default function App() {
  return (
    <MeshProvider>
      <YourScreen />
    </MeshProvider>
  );
}

function YourScreen() {
  const { status, peers, broadcast } = useMesh();

  useMeshMessages((message) => {
    const event = JSON.parse(message.json);
    // handle event
  });

  // status === "running": broadcast(JSON.stringify({ type: "hello" }))
}
```

Mount a single `MeshProvider`, near the root: there is one Bluetooth radio. The permission prompt appears when the provider mounts, so mount it where you want the prompt to show.

### Status

`useMesh().status` is one of:

| Status              | Meaning                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starting`          | Bluetooth is usable (or the user is answering the permission prompt) and the mesh is starting.                                                             |
| `running`           | The mesh is up. `broadcast` works.                                                                                                                         |
| `bluetooth_off`     | Bluetooth is turned off. iOS shows no system alert for it, so tell the user yourself. The mesh starts by itself once it is turned on.                      |
| `permission_denied` | The user denied Bluetooth permission. Send them to Settings (`Linking.openSettings()`); the mesh starts when they come back with it granted.               |
| `unsupported`       | The device has no Bluetooth LE, or cannot advertise (for example the iOS Simulator).                                                                       |
| `error`             | The mesh failed to start 3 times in a row (retrying after 1 s, then 2 s). `useMesh().error` says why. Toggling Bluetooth or reopening the app tries again. |

On Android the permission dialog is shown once per app launch; after a denial, the user grants the permission in Settings.

### Sending

`broadcast(json)` sends a JSON string to every nearby device. It rejects with `MeshNotRunningError` when the status is not `running`:

```ts
import { MeshNotRunningError } from "@shotgun/mesh";

try {
  await broadcast(JSON.stringify({ type: "hello" }));
} catch (error) {
  if (error instanceof MeshNotRunningError) {
    // error.status says why, for example "bluetooth_off"
  }
}
```

The error also has `code: "ERR_MESH_NOT_RUNNING"`.

### Receiving

`useMeshMessages(listener)` calls `listener` with every message received while the component is mounted, as `{ id, json, senderId, timestamp }`. `senderId` is the sender's device ID, so `getPeer(message.senderId)?.displayName` gives its name. The latest listener is always used, so it does not need `useCallback`. Messages that arrive while no listener is mounted are dropped.

### Peers

Each device has a device ID, generated once per install and kept across app restarts and Bluetooth toggles (it is not restored from backups, so two phones never share one). It is in every packet and in the Bluetooth advertisement, so a device is listed once, under that ID, from the moment it connects. Its `displayName` is the name it announces, which is its device name ("Galaxy A22 5G") unless that app set another. A peer leaves the list when its last direct link drops.

### Display name

Nearby devices see this device under its display name, which defaults to the device name. On iOS 16 and later, apps only get a generic name ("iPhone") unless they have the user-assigned device name entitlement, so you will usually want to set your own: pass `displayName` to `MeshProvider`, or call `setDisplayName` from `useMesh()`. Peers see a new name within seconds.

### API

`MeshProvider` props (all optional):

| Prop          | Default         | Description                                                                     |
| ------------- | --------------- | ------------------------------------------------------------------------------- |
| `displayName` | the device name | Name nearby devices see. Changing it renames the device, like `setDisplayName`. |
| `debug`       | `__DEV__`       | Verbose JS and native logs. Read once, on mount.                                |

`useMesh()` returns:

| Field                  | Description                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `status`               | See [Status](#status).                                                                                                   |
| `error`                | Why the mesh could not start, when `status` is `error`; otherwise `null`.                                                |
| `broadcast(json)`      | See [Sending](#sending).                                                                                                 |
| `peers`                | Devices on the mesh, most recently active first: `{ id, displayName, deviceName, rssi, lastSeen }`. See [Peers](#peers). |
| `connectedPeerCount`   | Number of direct Bluetooth links.                                                                                        |
| `getPeer(peerId)`      | A peer by its device ID.                                                                                                 |
| `deviceId`             | This device's ID: 8 hex chars, generated once per install. Peers see it as `peer.id`.                                    |
| `displayName`          | This device's display name.                                                                                              |
| `setDisplayName(name)` | Renames this device on the mesh. Blank names are ignored.                                                                |

## Repository layout

```
src/          TypeScript SDK (mesh router, React API, native module bindings in src/native)
ios/          Native module, iOS (Swift)
android/      Native module, Android (Kotlin)
plugin/       Expo config plugin
example/      Chat example app (not published)
```

## Example app

```sh
pnpm install           # at the repo root: installs the SDK and the example, builds the SDK + config plugin
cd example
pnpm prebuild
pnpm ios               # or pnpm android
pnpm start
```

The example's Metro config resolves `@shotgun/mesh` to `../src`, so JS changes to the SDK show up without a rebuild. Changes to the config plugin need `pnpm build` at the root, then `pnpm prebuild` in the example.

The repo is a pnpm workspace only so the example shares the SDK's dependencies (one copy of React and Expo); the published package is the repo root.

## Releasing

Publishing is done by [.github/workflows/release.yml](https://github.com/shotgun-warehouse/mesh/blob/main/.github/workflows/release.yml) when a `v*` tag is pushed:

1. Bump `version` in `package.json` and add an entry to [CHANGELOG.md](https://github.com/shotgun-warehouse/mesh/blob/main/CHANGELOG.md).
2. Merge to `main`, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.

The workflow checks that the tag matches the package version, builds, and publishes with provenance via npm trusted publishing (no token). Pre-release versions (`0.2.0-beta.1`) are published under the `next` dist-tag.
