import { AppState, Platform } from "react-native";

import BleBroadcast, { type BluetoothState } from "../native";
import { createUuid } from "./ids";
import {
  MAX_SEEN_MESSAGE_IDS,
  MAX_START_ATTEMPTS,
  START_RETRY_BASE_DELAY_MS,
} from "./constants";
import { MeshNotRunningError } from "./errors";
import { attachNativeMeshLogs, meshLog, setMeshLoggingEnabled } from "./logger";
import { requestMeshPermissions } from "./permissions";
import {
  MeshRouter,
  type MeshChatEvent,
  type MeshIdentityEvent,
  type MeshLinkDisconnectEvent,
  type MeshLinkEvent,
} from "./router";

/**
 * - `starting`: Bluetooth is usable (or the OS is still answering) and the mesh is starting,
 *   including between failed attempts.
 * - `running`: advertising and scanning; `broadcast` works.
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
  debug: boolean;
  onStatusChange: (status: MeshStatus, error: string | null) => void;
  /** The mesh stopped (Bluetooth went away): every peer link is gone. */
  onSessionStopped: () => void;
  onIdentity: (event: MeshIdentityEvent) => void;
  onChatMessage: (event: MeshChatEvent) => void;
  onLinkConnected: (event: MeshLinkEvent) => void;
  onLinkDisconnected: (event: MeshLinkDisconnectEvent) => void;
  onPeerCountChange: (connectedPeerCount: number) => void;
};

type RefreshReason = "mount" | "bluetooth" | "foreground" | "retry";

// The native module is a singleton, so every lifecycle shares one operation queue: a provider
// that unmounts (or React StrictMode's mount → unmount → mount) finishes stopping before the
// next one starts, and start/stop never interleave.
let nativeOperationQueue: Promise<void> = Promise.resolve();
let mountedLifecycleCount = 0;
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
  private displayName: string;
  private failedStartAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private isDisposed = false;
  private readonly seenMessageIds = new Set<string>();
  private bluetoothStateSubscription: { remove: () => void } | null = null;
  private appStateSubscription: { remove: () => void } | null = null;
  private nativeLogSubscription: { remove: () => void } | null = null;

  constructor(private readonly options: MeshLifecycleOptions) {
    this.displayName = options.displayName;
  }

  start(): void {
    mountedLifecycleCount += 1;
    if (mountedLifecycleCount > 1) {
      meshLog(
        "lifecycle",
        "More than one MeshProvider is mounted. They share one Bluetooth radio and stop each other; mount a single MeshProvider near the root of the app.",
        undefined,
        "warn",
      );
    }

    setMeshLoggingEnabled(this.options.debug);
    if (this.options.debug) {
      this.nativeLogSubscription = attachNativeMeshLogs();
    }

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
      if (mountedLifecycleCount === 0) {
        setMeshLoggingEnabled(false);
      }
    });
  }

  setDisplayName(displayName: string): void {
    this.displayName = displayName;
    this.router?.setDisplayName(displayName);
  }

  async broadcast(json: string): Promise<void> {
    const router = this.router;
    if (this.isDisposed || this.status !== "running" || !router) {
      throw new MeshNotRunningError(this.status);
    }

    const trimmedJson = json.trim();
    if (!trimmedJson) {
      return;
    }

    const messageId = createUuid();
    this.markMessageSeen(messageId);

    meshLog("send", "Broadcasting mesh payload", {
      jsonChars: trimmedJson.length,
      messageId,
    });

    await router.sendBroadcast(trimmedJson, messageId);
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
      // Status first, so a broadcast() during the stop reports why it failed.
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
        onChatMessage: (chatEvent) => {
          if (
            this.isCurrentRouter(router) &&
            this.markMessageSeen(chatEvent.messageId)
          ) {
            this.options.onChatMessage(chatEvent);
          }
        },
        onLinkConnected: (linkEvent) => {
          if (this.isCurrentRouter(router)) {
            this.options.onLinkConnected(linkEvent);
          }
        },
        onLinkDisconnected: (disconnectEvent) => {
          if (this.isCurrentRouter(router)) {
            this.options.onLinkDisconnected(disconnectEvent);
          }
        },
        onPeerCountChange: (connectedPeerCount) => {
          if (this.isCurrentRouter(router)) {
            this.options.onPeerCountChange(connectedPeerCount);
          }
        },
      },
    );
    this.router = router;

    try {
      // Router first, so it is listening before the first peer can connect.
      await router.start();
      await BleBroadcast.startBroadcastAsync(this.options.deviceId);
      await BleBroadcast.startScanAsync();
    } catch (startError) {
      this.router = null;
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

  /** Returns false when the message was already delivered (or sent by this device). */
  private markMessageSeen(messageId: string): boolean {
    if (this.seenMessageIds.has(messageId)) {
      return false;
    }

    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
      // Sets iterate in insertion order: drop the oldest.
      const oldestMessageId = this.seenMessageIds.values().next().value;
      if (oldestMessageId !== undefined) {
        this.seenMessageIds.delete(oldestMessageId);
      }
    }
    return true;
  }
}
