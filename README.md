# Shotgun Mesh

Monorepo for **`@shotgun/mesh`** — a BLE mesh networking SDK for Expo apps — and a chat example.

## Structure

```
packages/mesh/     @shotgun/mesh SDK (native BLE module + mesh router + React API)
examples/chat/     Example Expo app (not published)
```

## Install in another Expo app

```sh
npm install @shotgun/mesh expo-dev-client
```

```ts
// app.config.ts
plugins: ["@shotgun/mesh/plugin"];
```

```json
// package.json — required so Expo autolinks the nested BleBroadcast native module
{
  "expo": {
    "autolinking": {
      "searchPaths": ["node_modules/@shotgun/mesh/modules"]
    }
  }
}
```

```tsx
import { MeshProvider, useMesh } from "@shotgun/mesh";

function App() {
  return (
    <MeshProvider>
      <YourScreen />
    </MeshProvider>
  );
}

function YourScreen() {
  const { start, stop, broadcast, peers, isReady } = useMesh();

  useEffect(() => {
    void start({
      displayName: "My Phone",
      onMessage: (message) => {
        const event = JSON.parse(message.json);
        // handle event
      },
    });
    return () => {
      void stop();
    };
  }, [start, stop]);

  // broadcast(JSON.stringify({ type: "hello" }))
}
```

Requires **`expo-dev-client`** and a native build (`npx expo prebuild`).

## Example app

```sh
npm install
npm run prebuild   # from repo root — runs in examples/chat
npm run ios        # or npm run android
npm start
```

## Publish SDK

From `packages/mesh`:

```sh
npm publish --registry <your-private-registry>
```
