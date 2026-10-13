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
import { MeshNotRunningError } from "../mesh/errors";
import { createDeviceId, isDeviceId } from "../mesh/ids";
import { MeshLifecycle } from "../mesh/lifecycle";
import { meshLog } from "../mesh/logger";

import {
  MeshContext,
  MeshMessagesContext,
  type MeshContextValue,
  type MeshMessageSubscribe,
} from "./MeshContext";
import {
  removePeer,
  toMeshPeer,
  upsertPeer,
  type MeshPeerRecord,
  type MeshPeerUpdate,
} from "./peerUtils";
import type {
  MeshInboundMessage,
  MeshMessageListener,
  MeshStatus,
} from "./types";

export type MeshProviderProps = {
  children: ReactNode;
  /**
   * Name nearby peers see for this device. Defaults to the device name. Changing the prop renames
   * the device on the mesh, like `setDisplayName`.
   */
  displayName?: string;
  /** Verbose JS and native mesh logs. Defaults to `__DEV__`. Read once, on mount. */
  debug?: boolean;
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
}: MeshProviderProps) {
  const [deviceId] = useState(getLocalDeviceId);
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
  const messageListenersRef = useRef(new Set<MeshMessageListener>());
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
      onChatMessage: (chatEvent) => {
        updatePeer({ id: chatEvent.senderId, lastSeen: chatEvent.timestamp });

        const message: MeshInboundMessage = {
          id: chatEvent.messageId,
          json: chatEvent.text,
          senderId: chatEvent.senderId,
          timestamp: chatEvent.timestamp,
        };

        for (const listener of messageListenersRef.current) {
          try {
            listener(message);
          } catch (listenerError) {
            meshLog(
              "message",
              "A useMeshMessages listener threw",
              {
                message:
                  listenerError instanceof Error
                    ? listenerError.message
                    : String(listenerError),
              },
              "error",
            );
          }
        }
      },
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

  const broadcast = useCallback(async (json: string) => {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle) {
      throw new MeshNotRunningError("starting");
    }
    await lifecycle.broadcast(json);
  }, []);

  const peers = useMemo(() => peerRecords.map(toMeshPeer), [peerRecords]);

  const getPeer = useCallback(
    (peerId: string) => peers.find((peer) => peer.id === peerId),
    [peers],
  );

  const subscribeToMessages = useCallback<MeshMessageSubscribe>((listener) => {
    messageListenersRef.current.add(listener);
    return () => {
      messageListenersRef.current.delete(listener);
    };
  }, []);

  const value = useMemo<MeshContextValue>(
    () => ({
      status,
      error,
      deviceId,
      displayName,
      setDisplayName,
      peers,
      connectedPeerCount,
      broadcast,
      getPeer,
    }),
    [
      status,
      error,
      deviceId,
      displayName,
      setDisplayName,
      peers,
      connectedPeerCount,
      broadcast,
      getPeer,
    ],
  );

  return (
    <MeshMessagesContext.Provider value={subscribeToMessages}>
      <MeshContext.Provider value={value}>{children}</MeshContext.Provider>
    </MeshMessagesContext.Provider>
  );
}
