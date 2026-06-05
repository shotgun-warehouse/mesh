import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

import BleBroadcast from "../../modules/ble-broadcast";
import { createClientId } from "../mesh/clientId";
import {
  attachNativeMeshLogs,
  meshLog,
  setMeshLoggingEnabled,
} from "../mesh/logger";
import { requestMeshPermissions } from "../mesh/permissions";
import { MeshRouter } from "../mesh/router";

import { MeshAlreadyStartedError, MeshNotReadyError } from "./errors";
import { MeshContext, type MeshContextValue } from "./MeshContext";
import {
  findPeerById,
  sortPeersByActivity,
  toMeshPeer,
  upsertPeer,
} from "./peerUtils";
import type {
  MeshInboundMessage,
  MeshPeer,
  MeshStartOptions,
  MeshStatus,
} from "./types";

type ActiveSession = {
  clientId: string;
  displayName: string;
  debug: boolean;
  onMessage: (message: MeshInboundMessage) => void;
  router: MeshRouter;
  nativeLogSubscription: { remove: () => void };
};

export function MeshProvider({ children }: { children: React.ReactNode }) {
  const sessionRef = useRef<ActiveSession | null>(null);
  const startPromiseRef = useRef<Promise<void> | null>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());

  const [status, setStatus] = useState<MeshStatus>("idle");
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [connectedPeerCount, setConnectedPeerCount] = useState(0);
  const [peers, setPeers] = useState<MeshPeer[]>([]);

  const teardownSession = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }

    sessionRef.current = null;
    startPromiseRef.current = null;
    seenMessageIdsRef.current.clear();

    meshLog("session", "Mesh session stopping");
    setMeshLoggingEnabled(false);

    session.nativeLogSubscription.remove();
    await session.router.stop();
    await BleBroadcast.stopScanAsync();
    await BleBroadcast.stopBroadcastAsync();

    setPeers([]);
    setConnectedPeerCount(0);
    setClientId(null);
    setDisplayName(null);
    setIsReady(false);
    setStatus("idle");
    setError(null);
  }, []);

  const stop = useCallback(async () => {
    await teardownSession();
  }, [teardownSession]);

  const start = useCallback(async (options: MeshStartOptions) => {
    if (sessionRef.current || startPromiseRef.current) {
      throw new MeshAlreadyStartedError();
    }

    const nextClientId = options.clientId ?? createClientId();
    const debugEnabled = options.debug ?? __DEV__;
    const messageHandler = options.onMessage;
    setMeshLoggingEnabled(debugEnabled);

    setStatus("starting");
    setError(null);
    setClientId(nextClientId);
    setDisplayName(options.displayName);

    const startPromise = (async () => {
      const nativeLogSubscription = debugEnabled
        ? attachNativeMeshLogs()
        : { remove: () => {} };

      const router = new MeshRouter(nextClientId, options.displayName, {
        onIdentity: (identityEvent) => {
          setPeers((previousPeers) =>
            sortPeersByActivity(
              upsertPeer(
                previousPeers,
                toMeshPeer({
                  clientId: identityEvent.senderId,
                  bleDeviceId: identityEvent.bleDeviceId,
                  isIdentified: true,
                  deviceName: identityEvent.deviceName,
                  displayName: identityEvent.displayName,
                  rssi: identityEvent.rssi,
                  lastSeen: identityEvent.timestamp,
                }),
              ),
            ),
          );
        },
        onChatMessage: (chatEvent) => {
          if (seenMessageIdsRef.current.has(chatEvent.messageId)) {
            return;
          }

          seenMessageIdsRef.current.add(chatEvent.messageId);

          setPeers((previousPeers) =>
            sortPeersByActivity(
              upsertPeer(
                previousPeers,
                toMeshPeer({
                  clientId: chatEvent.senderId,
                  bleDeviceId: chatEvent.bleDeviceId,
                  isIdentified: true,
                  deviceName: chatEvent.deviceName,
                  displayName: chatEvent.displayName,
                  rssi: chatEvent.rssi,
                  lastSeen: chatEvent.timestamp,
                }),
              ),
            ),
          );

          messageHandler({
            json: chatEvent.text,
            senderId: chatEvent.senderId,
            displayName: chatEvent.displayName,
            timestamp: chatEvent.timestamp,
            bleDeviceId: chatEvent.bleDeviceId,
            deviceName: chatEvent.deviceName,
            rssi: chatEvent.rssi,
          });
        },
        onLinkConnected: (linkEvent) => {
          setPeers((previousPeers) =>
            sortPeersByActivity(
              upsertPeer(
                previousPeers,
                toMeshPeer({
                  clientId: null,
                  bleDeviceId: linkEvent.bleDeviceId,
                  isIdentified: false,
                  deviceName: linkEvent.deviceName,
                  rssi: linkEvent.rssi,
                  lastSeen: Date.now(),
                }),
              ),
            ),
          );
        },
        onPeerCountChange: (nextConnectedPeerCount) => {
          setConnectedPeerCount(nextConnectedPeerCount);
        },
      });

      try {
        const permissionsGranted = await requestMeshPermissions();
        if (!permissionsGranted) {
          nativeLogSubscription.remove();
          setStatus("permissions_denied");
          setError("Bluetooth permissions are required.");
          setIsReady(false);
          return;
        }

        await BleBroadcast.startBroadcastAsync("");
        await BleBroadcast.startScanAsync();
        await router.start();

        sessionRef.current = {
          clientId: nextClientId,
          displayName: options.displayName,
          debug: debugEnabled,
          onMessage: messageHandler,
          router,
          nativeLogSubscription,
        };

        meshLog("session", "Mesh session started", {
          clientId: nextClientId,
          displayName: options.displayName,
        });

        setStatus("active");
        setIsReady(true);
      } catch (startError) {
        nativeLogSubscription.remove();
        await router.stop();
        await BleBroadcast.stopScanAsync();
        await BleBroadcast.stopBroadcastAsync();

        const message =
          startError instanceof Error
            ? startError.message
            : "Unknown BLE error";

        meshLog(
          "session",
          "Mesh session failed to start",
          { message },
          "error",
        );
        setStatus("error");
        setError(message);
        setIsReady(false);
      }
    })();

    startPromiseRef.current = startPromise;

    try {
      await startPromise;
    } finally {
      if (startPromiseRef.current === startPromise) {
        startPromiseRef.current = null;
      }
    }
  }, []);

  const broadcast = useCallback(async (json: string) => {
    const session = sessionRef.current;
    const trimmedJson = json.trim();

    if (!session || !trimmedJson) {
      if (!session) {
        throw new MeshNotReadyError();
      }
      return;
    }

    const messageId = createClientId();
    seenMessageIdsRef.current.add(messageId);

    meshLog("send", "Broadcasting mesh payload", {
      jsonChars: trimmedJson.length,
      messageId,
    });

    await session.router.sendBroadcast(trimmedJson, messageId);
  }, []);

  const getPeer = useCallback(
    (peerId: string) => findPeerById(peers, peerId),
    [peers],
  );

  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === "active" && sessionRef.current) {
        meshLog("session", "App foregrounded — mesh session remains active");
      }
    };

    const subscription = AppState.addEventListener(
      "change",
      handleAppStateChange,
    );
    return () => {
      subscription.remove();
      void teardownSession();
    };
  }, [teardownSession]);

  const value = useMemo<MeshContextValue>(
    () => ({
      status,
      isReady,
      error,
      clientId,
      displayName,
      connectedPeerCount,
      peers,
      start,
      stop,
      broadcast,
      getPeer,
    }),
    [
      status,
      isReady,
      error,
      clientId,
      displayName,
      connectedPeerCount,
      peers,
      start,
      stop,
      broadcast,
      getPeer,
    ],
  );

  return <MeshContext.Provider value={value}>{children}</MeshContext.Provider>;
}
