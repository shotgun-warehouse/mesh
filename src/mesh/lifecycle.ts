import { AppState, Platform } from "react-native";

import BleBroadcast, { type BluetoothState } from "../native";
import { MAX_START_ATTEMPTS, START_RETRY_BASE_DELAY_MS } from "./constants";
import { meshLog } from "./logger";
import { attachNativeMeshLogs } from "./nativeLogs";
import { nativeMeshTransport } from "./nativeTransport";
import { requestMeshPermissions } from "./permissions";
import { MeshItemSync } from "../sync/itemSync";
import { nativeItemPersistence } from "../sync/nativePersistence";
import type { MeshSyncOptions } from "../sync/sync";
import type { MeshItem, MeshKeyedItem } from "../sync/types";
import { deviceIdFromKey } from "./ids";
import {
  MeshRouter,
  type MeshIdentityEvent,
  type MeshLinkEvent,
} from "./router";

/**
 * - `starting`: Bluetooth is usable (or the OS is still answering) and the mesh is starting,
 *   including between failed attempts.
 * - `running`: advertising and scanning; items spread to peers.
 * - `bluetooth_off`: Bluetooth is turned off.
 * - `permission_denied`: the user denied (or a policy restricts) Bluetooth permission.
 * - `unsupported`: this device cannot run the mesh (no Bluetooth LE, or no peripheral mode).
 * - `error`: Bluetooth is usable but the mesh failed to start `MAX_START_ATTEMPTS` times in a row.
 *   The next Bluetooth state change or app foregrounding tries again.
 */
export type MeshStatus =
  | "starting"
  | "running"
  | "bluetooth_off"
  | "permission_denied"
  | "unsupported"
  | "error";

export type MeshLifecycleOptions = {
  /** This device's ID (see `DEVICE_ID_BYTES`), sent in every packet and advertised. */
  deviceId: string;
  displayName: string;
  onStatusChange: (status: MeshStatus, error: string | null) => void;
  /** The mesh stopped (Bluetooth went away): every peer link is gone. */
  onSessionStopped: () => void;
  onIdentity: (event: MeshIdentityEvent) => void;
  onLinkConnected: (event: MeshLinkEvent) => void;
  /** The last link to a device dropped: it is no longer a direct neighbour. */
  onNeighbourDown: (deviceId: string) => void;
  onPeerCountChange: (connectedPeerCount: number) => void;
  /** Sync knobs, read live. */
  syncOptions: () => MeshSyncOptions | undefined;
  /**
   * The item set to sync, e.g. the current event; items of other scopes are ignored. `null`
   * turns sync off (the mesh still relays other devices' packets).
   */
  syncScope: string | null;
  /** Items this device did not have, from peers (already saved). */
  onItems: (items: MeshItem[]) => void;
};

type RefreshReason = "mount" | "bluetooth" | "foreground" | "retry";

// The native module is a singleton, so every lifecycle shares one operation queue: a provider
// that unmounts (or React StrictMode's mount → unmount → mount) finishes stopping before the
// next one starts, and start/stop never interleave.
let nativeOperationQueue: Promise<void> = Promise.resolve();
let mountedLifecycleCount = 0;
/** Started, not yet disposed: `clearMeshItems` empties their sets in memory too. */
const liveLifecycles = new Set<MeshLifecycle>();
// Android shows the permission dialog once per app launch. After a denial the user grants it in
// Settings; the foreground refresh picks that up.
let hasRequestedAndroidPermissions = false;

function enqueueNativeOperation(operation: () => Promise<void>): void {
  nativeOperationQueue = nativeOperationQueue
    .then(operation)
    .catch((operationError) => {
      meshLog(
        "lifecycle",
        "Mesh lifecycle operation failed",
        { message: toErrorMessage(operationError) },
        "error",
      );
    });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusForUnavailableBluetooth(
  bluetoothState: Exclude<BluetoothState, "poweredOn">,
): MeshStatus {
  switch (bluetoothState) {
    case "poweredOff":
      return "bluetooth_off";
    case "unauthorized":
      return "permission_denied";
    case "unsupported":
      return "unsupported";
    case "unknown":
      return "starting";
  }
}

/**
 * Owns the mesh session for a `MeshProvider`: watches Bluetooth state, starts the mesh as soon
 * as Bluetooth is usable (retrying with backoff), and stops it when Bluetooth goes away.
 */
export class MeshLifecycle {
  private status: MeshStatus = "starting";
  private error: string | null = null;
  private router: MeshRouter | null = null;
  /** The replicated item set; outlives sessions (Bluetooth off and on keeps it). */
  private readonly itemSync: MeshItemSync;
  private displayName: string;
  private failedStartAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private isDisposed = false;
  private bluetoothStateSubscription: { remove: () => void } | null = null;
  private appStateSubscription: { remove: () => void } | null = null;
  private nativeLogSubscription: { remove: () => void } | null = null;

  constructor(private readonly options: MeshLifecycleOptions) {
    this.displayName = options.displayName;
    this.itemSync = new MeshItemSync({
      deviceId: options.deviceId,
      persistence: nativeItemPersistence,
      syncOptions: options.syncOptions,
      onItems: (items) =>
        this.isDisposed ? undefined : options.onItems(items),
      log: meshLog,
    });
    void this.itemSync.setScope(options.syncScope);
  }

  start(): void {
    mountedLifecycleCount += 1;
    liveLifecycles.add(this);
    if (mountedLifecycleCount > 1) {
      meshLog(
        "lifecycle",
        "More than one MeshProvider is mounted. They share one Bluetooth radio and stop each other; mount a single MeshProvider near the root of the app.",
        undefined,
        "warn",
      );
    }

    this.nativeLogSubscription = attachNativeMeshLogs();

    this.options.onStatusChange(this.status, this.error);

    // Subscribe before the first state read so no change is missed in between.
    this.bluetoothStateSubscription = BleBroadcast.addListener(
      "onBluetoothStateChange",
      () => {
        this.refresh("bluetooth");
      },
    );
    this.appStateSubscription = AppState.addEventListener(
      "change",
      (appState) => {
        if (appState === "active") {
          this.refresh("foreground");
        }
      },
    );

    this.refresh("mount");
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    mountedLifecycleCount -= 1;
    liveLifecycles.delete(this);
    this.clearRetryTimer();
    this.bluetoothStateSubscription?.remove();
    this.appStateSubscription?.remove();
    this.bluetoothStateSubscription = null;
    this.appStateSubscription = null;

    // Not `this.enqueue`: that skips work once disposed, and this stop has to run.
    enqueueNativeOperation(async () => {
      await this.stopSession();
      this.nativeLogSubscription?.remove();
      this.nativeLogSubscription = null;
    });
  }

  setDisplayName(displayName: string): void {
    this.displayName = displayName;
    this.router?.setDisplayName(displayName);
  }

  /**
   * Adds an item to the replicated set, persists it and floods it when the mesh is running. Works
   * in any status: an item published offline spreads through repair once peers are around.
   */
  publishItem(data: string): Promise<MeshItem> {
    return this.itemSync.publish(data, Date.now());
  }

  /** Switches the synced set (loads it from disk; the old one stays on disk). `null`: no sync. */
  setSyncScope(scope: string | null): Promise<void> {
    return this.itemSync.setScope(scope);
  }

  /** Seeds `scope`'s set with items the app holds elsewhere; see `MeshContextValue.addItems`. */
  async addItems(scope: string, items: MeshKeyedItem[]): Promise<void> {
    const meshItems = items.map(({ deviceKey, seq, createdAt, data }) => {
      if (!deviceKey.trim()) {
        throw new Error(
          `addItems got an item (seq ${seq}) with a blank deviceKey`,
        );
      }
      return { author: deviceIdFromKey(deviceKey), seq, createdAt, data };
    });
    await this.itemSync.addItems(scope, meshItems);
  }

  /** Deletes the synced items; see `clearMeshItems`. */
  clearItems(): Promise<void> {
    return this.itemSync.clear();
  }

  /** Compares with neighbours now (repair just turned on). */
  compareNow(): void {
    this.itemSync.compareNow();
  }

  private enqueue(operation: () => Promise<void>): void {
    enqueueNativeOperation(async () => {
      if (this.isDisposed) {
        return;
      }
      await operation();
    });
  }

  private refresh(reason: RefreshReason): void {
    this.enqueue(async () => {
      let bluetoothState = await BleBroadcast.getBluetoothStateAsync();

      if (
        bluetoothState === "unauthorized" &&
        Platform.OS === "android" &&
        !hasRequestedAndroidPermissions
      ) {
        hasRequestedAndroidPermissions = true;
        meshLog("lifecycle", "Requesting Bluetooth permissions");
        await requestMeshPermissions().catch(() => false);
        bluetoothState = await BleBroadcast.getBluetoothStateAsync();
      }

      if (this.isDisposed) {
        return;
      }

      meshLog("lifecycle", "Bluetooth state checked", {
        bluetoothState,
        reason,
      });
      await this.applyBluetoothState(bluetoothState, reason);
    });
  }

  private async applyBluetoothState(
    bluetoothState: BluetoothState,
    reason: RefreshReason,
  ): Promise<void> {
    if (bluetoothState !== "poweredOn") {
      this.clearRetryTimer();
      this.failedStartAttempts = 0;
      this.setStatus(statusForUnavailableBluetooth(bluetoothState), null);
      await this.stopSession();
      return;
    }

    if (this.router) {
      // Bluetooth can reset and come back before this refresh runs (or while the app is
      // suspended), and native drops advertising and scanning on a reset. Restart if it did.
      if (await this.isNativeRuntimeUp()) {
        return;
      }
      meshLog(
        "lifecycle",
        "Mesh runtime went down while Bluetooth stayed on; restarting",
        { reason },
        "warn",
      );
      this.setStatus("starting", null);
      await this.stopSession();
      if (this.isDisposed) {
        return;
      }
      await this.startSession();
      return;
    }

    if (reason !== "retry") {
      // A retry is already scheduled for this round of attempts: let it run.
      if (this.retryTimer !== null) {
        return;
      }
      // Something changed since the last round gave up: start a new round.
      if (this.status === "error") {
        this.failedStartAttempts = 0;
      }
    }

    await this.startSession();
  }

  private async startSession(): Promise<void> {
    this.setStatus("starting", null);

    // Callbacks from a router that was stopped (or from a disposed lifecycle) can still arrive
    // from in-flight native calls; only the current router may update the provider.
    const router: MeshRouter = new MeshRouter(
      this.options.deviceId,
      this.displayName,
      {
        onIdentity: (identityEvent) => {
          if (this.isCurrentRouter(router)) {
            this.options.onIdentity(identityEvent);
          }
        },
        onLinkConnected: (linkEvent) => {
          if (this.isCurrentRouter(router)) {
            this.options.onLinkConnected(linkEvent);
          }
        },
        onNeighbourUp: (deviceId) => {
          if (this.isCurrentRouter(router)) {
            this.itemSync.neighbourUp(deviceId);
          }
        },
        onNeighbourDown: (deviceId) => {
          if (this.isCurrentRouter(router)) {
            this.options.onNeighbourDown(deviceId);
            this.itemSync.neighbourDown(deviceId);
          }
        },
        onSyncPacket: (packet, linkDeviceId) => {
          if (this.isCurrentRouter(router)) {
            this.itemSync.handlePacket(packet, linkDeviceId);
          }
        },
        onPeerCountChange: (connectedPeerCount) => {
          if (this.isCurrentRouter(router)) {
            this.options.onPeerCountChange(connectedPeerCount);
          }
        },
      },
      { transport: nativeMeshTransport, logger: meshLog },
    );
    this.router = router;

    try {
      // Router first, so it is listening before the first peer can connect.
      await router.start();
      this.itemSync.attach(router);
      await BleBroadcast.startBroadcastAsync(this.options.deviceId);
      await BleBroadcast.startScanAsync();
    } catch (startError) {
      this.router = null;
      this.itemSync.detach();
      await this.stopNative(router);
      // A peer may have linked between advertising and the failure.
      if (!this.isDisposed) {
        this.options.onSessionStopped();
      }
      this.handleStartFailure(toErrorMessage(startError));
      return;
    }

    this.failedStartAttempts = 0;
    meshLog("session", "Mesh session started", {
      deviceId: this.options.deviceId,
      displayName: this.displayName,
    });
    this.setStatus("running", null);
  }

  private handleStartFailure(message: string): void {
    if (this.isDisposed) {
      return;
    }

    this.failedStartAttempts += 1;
    meshLog(
      "session",
      "Mesh session failed to start",
      {
        attempt: this.failedStartAttempts,
        maxAttempts: MAX_START_ATTEMPTS,
        message,
      },
      "warn",
    );

    if (this.failedStartAttempts >= MAX_START_ATTEMPTS) {
      this.setStatus("error", message);
      return;
    }

    const retryDelayMs =
      START_RETRY_BASE_DELAY_MS * 2 ** (this.failedStartAttempts - 1);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.refresh("retry");
    }, retryDelayMs);
  }

  private async stopSession(): Promise<void> {
    const router = this.router;
    if (!router) {
      return;
    }

    this.router = null;
    meshLog("session", "Mesh session stopping");
    this.itemSync.detach();
    await this.stopNative(router);

    if (!this.isDisposed) {
      this.options.onSessionStopped();
    }
  }

  private async isNativeRuntimeUp(): Promise<boolean> {
    const [isBroadcasting, isScanning] = await Promise.all([
      BleBroadcast.isBroadcastingAsync(),
      BleBroadcast.isScanningAsync(),
    ]);
    return isBroadcasting && isScanning;
  }

  private async stopNative(router: MeshRouter): Promise<void> {
    await router.stop();
    // Best effort: Bluetooth may already be off, and native already dropped everything then.
    await BleBroadcast.stopScanAsync().catch(() => undefined);
    await BleBroadcast.stopBroadcastAsync().catch(() => undefined);
  }

  private isCurrentRouter(router: MeshRouter): boolean {
    return !this.isDisposed && this.router === router;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private setStatus(status: MeshStatus, error: string | null): void {
    if (this.isDisposed || (status === this.status && error === this.error)) {
      return;
    }

    meshLog("lifecycle", "Mesh status changed", {
      from: this.status,
      to: status,
      error,
    });
    this.status = status;
    this.error = error;
    this.options.onStatusChange(status, error);
  }
}

/**
 * Deletes every synced item this device holds, in every scope, to free its storage (for example
 * on logout). A mounted `MeshProvider` keeps running on an emptied set, and repair fetches back
 * what neighbours of its current scope still hold. This device keeps numbering its own items after
 * the deleted ones, so peers that hold them never mistake a new item for an old one.
 */
export async function clearMeshItems(): Promise<void> {
  if (liveLifecycles.size === 0) {
    await nativeItemPersistence.clearAll();
    return;
  }
  await Promise.all(
    [...liveLifecycles].map((lifecycle) => lifecycle.clearItems()),
  );
}
