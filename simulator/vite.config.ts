/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const fromHere = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The mesh code only reads `Platform.OS` from react-native (for log lines).
      "react-native": fromHere("./src/shims/react-native.ts"),
      "@mesh": fromHere("../src/mesh"),
      "@sync": fromHere("../src/sync"),
    },
  },
  server: {
    fs: { allow: [fromHere("..")] },
  },
  worker: { format: "es" },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
  },
});
