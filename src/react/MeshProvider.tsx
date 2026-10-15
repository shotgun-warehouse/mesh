import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Platform } from "react-native";

import BleBroadcast from "../native";
import { DEVICE_ID_BYTES } from "../mesh/constants";
import { createDeviceId, deviceIdFromKey, isDeviceId } from "../mesh/ids";
import { MeshLifecycle } from "../mesh/lifecycle";
import { resolveSyncOptions, type MeshSyncOptions } from "../sync/sync";

import { MeshContext, type MeshContextValue } from "./MeshContext";
import {
  removePeer,
  toMeshPeer,
  upsertPeer,
  type MeshPeerRecord,
  type MeshPeerUpdate,
} from "./peerUtils";
import type { MeshItemsListener, MeshStatus } from "./types";

export type MeshProviderProps = {
  children: ReactNode;
  /**
   * Name nearby peers see for this device. Defaults to the device name. Changing the prop renames
   * the device on the mesh, like `setDisplayName`.
   */
  displayName?: string;
  /** Verbose JS and native mesh logs. Defaults to `__DEV__`. Read once, on mount. */
  debug?: boolean;
  /**
   * Which synced item set this device works on (for example the current event ID): items are
   * saved per scope and devices only sync items of the same scope. Changing it switches sets.
   * `null` turns sync off: no set is loaded, nothing is published or received, and the mesh still
   * relays other devices' packets.
   */
  syncScope: string | null;
  /**
   * The app's own ID for this install (for example the ID its server knows the device by). When
   * set, the mesh device ID is derived from it (a hash), so every item this device publishes is
   * authored by that ID and `addItems` can match server copies to mesh items. Keep it stable per
   * install; changing it restarts the mesh under the new ID. Must not be blank. Without it, the
   * device ID is random, generated once per install.
   */
  deviceKey?: string;
  /**
   * Called with items published on other devices, the first time each reaches this one. The
   * library has already deduplicated and saved them; do what you like with them. Each item comes
   * once, across restarts too (only an item that arrives as the app is killed, before its save
   * lands, can come again).
   */
  onItemsReceived?: MeshItemsListener;
  /**
   * Knobs for item sync (`publishItem` / `onItemsReceived`). Read live: a change applies within a
   * sync round, with no restart. Omitted fields keep their defaults (`DEFAULT_SYNC_OPTIONS`).
   */
  sync?: MeshSyncOptions;
};

function normalizeDisplayName(displayName: string | undefined): string | null {
  const trimmedDisplayName = displayName?.trim();
  return trimmedDisplayName ? trimmedDisplayName : null;
}

/** This install's device ID, persisted by the native module (a random one when it cannot). */
function getLocalDeviceId(): string {
  try {
    const deviceId = BleBroadcast.getMeshId(DEVICE_ID_BYTES);
    if (isDeviceId(deviceId)) {
      return deviceId;
    }
  } catch {
    // Fall through to an ID for this launch only.
  }
  return createDeviceId();
}

function resolveDeviceId(deviceKey: string | undefined): string {
  if (deviceKey === undefined) {
    return getLocalDeviceId();
  }
  if (!deviceKey.trim()) {
    throw new Error("MeshProvider deviceKey must not be blank");
  }
  return deviceIdFromKey(deviceKey);
}

function getDefaultDisplayName(): string {
  return (
    normalizeDisplayName(BleBroadcast.deviceName ?? undefined) ??
    (Platform.OS === "ios" ? "iPhone" : "Android device")
  );
}

/**
 * Runs the mesh for everything inside it. Mount it once, near the root: it asks for Bluetooth
 * permission, starts the mesh as soon as Bluetooth is usable, and stops and restarts it as
 * Bluetooth is turned off and on. Read the state with `useMesh()`.
 */
export function MeshProvider({
  children,
  displayName: displayNameProp,
  debug = __DEV__,
  syncScope,
  deviceKey,
  onItemsReceived,
  sync,
}: MeshProviderProps) {
  const deviceId = useMemo(() => resolveDeviceId(deviceKey), [deviceKey]);
  const [displayName, setDisplayNameState] = useState(
    () => normalizeDisplayName(displayNameProp) ?? getDefaultDisplayName(),
  );
  const [status, setStatus] = useState<MeshStatus>("starting");
  const [error, setError] = useState<string | null>(null);
  const [connectedPeerCount, setConnectedPeerCount] = useState(0);
  const [peerRecords, setPeerRecords] = useState<MeshPeerRecord[]>([]);

  const lifecycleRef = useRef<MeshLifecycle | null>(null);
  const displayNameRef = useRef(displayName);
  const debugRef = useRef(debug);
  const onItemsReceivedRef = useRef(onItemsReceived);
  onItemsReceivedRef.current = onItemsReceived;
  const syncOptionsRef = useRef(sync);
  syncOptionsRef.current = sync;
  const syncScopeRef = useRef(syncScope);
  const previousDisplayNamePropRef = useRef(displayNameProp);

  useEffect(() => {
    // BLE link → device ID, for the links this device opened (the only ones with disconnect
    // events). A peer is removed when its last such link drops.
    const directLinks = new Map<string, string>();

    const updatePeer = (update: MeshPeerUpdate) => {
      setPeerRecords((previousPeers) => upsertPeer(previousPeers, update));
    };

    const lifecycle = new MeshLifecycle({
      deviceId,
      displayName: displayNameRef.current,
      debug: debugRef.current,
      onStatusChange: (nextStatus, nextError) => {
        setStatus(nextStatus);
        setError(nextError);
      },
      onSessionStopped: () => {
        directLinks.clear();
        setPeerRecords([]);
        setConnectedPeerCount(0);
      },
      onIdentity: (identityEvent) => {
        updatePeer({
          id: identityEvent.senderId,
          announcedName: identityEvent.displayName,
          lastSeen: identityEvent.timestamp,
        });
      },
      onLinkConnected: (linkEvent) => {
        // A link whose advertisement had no device ID (an iOS app in the background) shows up
        // once the peer's identity packet arrives, right after the link is up.
        if (!linkEvent.deviceId) {
          return;
        }
        directLinks.set(linkEvent.bleDeviceId, linkEvent.deviceId);
        updatePeer({
          id: linkEvent.deviceId,
          deviceName: linkEvent.deviceName,
          rssi: linkEvent.rssi,
          lastSeen: Date.now(),
        });
      },
      onLinkDisconnected: (disconnectEvent) => {
        const peerId = directLinks.get(disconnectEvent.bleDeviceId);
        if (!peerId) {
          return;
        }
        directLinks.delete(disconnectEvent.bleDeviceId);
        if (![...directLinks.values()].includes(peerId)) {
          setPeerRecords((previousPeers) => removePeer(previousPeers, peerId));
        }
      },
      onPeerCountChange: setConnectedPeerCount,
      syncOptions: () => syncOptionsRef.current,
      syncScope: syncScopeRef.current,
      onItems: (items) => onItemsReceivedRef.current?.(items),
    });

    lifecycleRef.current = lifecycle;
    lifecycle.start();

    return () => {
      lifecycle.dispose();
      if (lifecycleRef.current === lifecycle) {
        lifecycleRef.current = null;
      }
    };
  }, [deviceId]);

  const setDisplayName = useCallback((nextDisplayName: string) => {
    const normalizedDisplayName = normalizeDisplayName(nextDisplayName);
    if (!normalizedDisplayName) {
      return;
    }

    displayNameRef.current = normalizedDisplayName;
    setDisplayNameState(normalizedDisplayName);
    lifecycleRef.current?.setDisplayName(normalizedDisplayName);
  }, []);

  useEffect(() => {
    const previousDisplayNameProp = previousDisplayNamePropRef.current;
    previousDisplayNamePropRef.current = displayNameProp;

    if (normalizeDisplayName(displayNameProp)) {
      setDisplayName(displayNameProp!);
    } else if (normalizeDisplayName(previousDisplayNameProp)) {
      // The prop was cleared (e.g. the user signed out): stop announcing the old name.
      setDisplayName(getDefaultDisplayName());
    }
  }, [displayNameProp, setDisplayName]);

  useEffect(() => {
    syncScopeRef.current = syncScope;
    void lifecycleRef.current?.setSyncScope(syncScope);
  }, [syncScope]);

  const publishItem = useCallback(async (data: string) => {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle) {
      throw new Error(
        "publishItem was called after the MeshProvider unmounted",
      );
    }
    return lifecycle.publishItem(data);
  }, []);

  const addItems = useCallback<MeshContextValue["addItems"]>(
    async (scope, items) => {
      const lifecycle = lifecycleRef.current;
      if (!lifecycle) {
        throw new Error("addItems was called after the MeshProvider unmounted");
      }
      return lifecycle.addItems(scope, items);
    },
    [],
  );

  // Repair turning on (the app caught up with its server): compare with neighbours now rather
  // than at the next beacons, which can be 16 s apart once idle.
  const repair = resolveSyncOptions(sync).repair;
  const previousRepairRef = useRef(repair);
  useEffect(() => {
    const previousRepair = previousRepairRef.current;
    previousRepairRef.current = repair;
    if (repair && !previousRepair) {
      lifecycleRef.current?.compareNow();
    }
  }, [repair]);

  const peers = useMemo(() => peerRecords.map(toMeshPeer), [peerRecords]);

  const getPeer = useCallback(
    (peerId: string) => peers.find((peer) => peer.id === peerId),
    [peers],
  );

  const value = useMemo<MeshContextValue>(
    () => ({
      status,
      error,
      deviceId,
      displayName,
      setDisplayName,
      peers,
      connectedPeerCount,
      getPeer,
      publishItem,
      addItems,
    }),
    [
      status,
      error,
      deviceId,
      displayName,
      setDisplayName,
      peers,
      connectedPeerCount,
      getPeer,
      publishItem,
      addItems,
    ],
  );

  return <MeshContext.Provider value={value}>{children}</MeshContext.Provider>;
}
