import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import * as Device from "expo-device";
import { StatusBar } from "expo-status-bar";
import {
  MeshProvider,
  useMesh,
  type MeshInboundMessage,
  type MeshPeer,
} from "@shotgun/mesh";

import { ChatScreen } from "./src/screens/ChatScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import type { ChatMessage, ChatWireMessage } from "./src/types";

function parseChatWireMessage(json: string): ChatWireMessage | null {
  try {
    const parsed = JSON.parse(json) as Partial<ChatWireMessage>;
    if (parsed.type === "chat" && typeof parsed.text === "string") {
      return { type: "chat", text: parsed.text };
    }
  } catch {
    return null;
  }
  return null;
}

function MeshChatApp() {
  const {
    start,
    stop,
    broadcast,
    peers,
    displayName,
    status,
    isReady,
    error,
    connectedPeerCount,
    getPeer,
  } = useMesh();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);

  const deviceDisplayName = useMemo(
    () =>
      Device.deviceName ??
      (Platform.OS === "ios" ? "iPhone" : "Android device"),
    [],
  );

  const localDisplayName = displayName ?? deviceDisplayName;

  const handleInboundMessage = useCallback((message: MeshInboundMessage) => {
    const wireMessage = parseChatWireMessage(message.json);
    if (!wireMessage) {
      return;
    }

    setMessages((previousMessages) => {
      const nextMessage: ChatMessage = {
        id: `${message.senderId}-${message.timestamp}`,
        text: wireMessage.text,
        timestamp: message.timestamp,
        outgoing: false,
        senderId: message.senderId,
        displayName: message.displayName,
      };

      if (
        previousMessages.some(
          (existingMessage) => existingMessage.id === nextMessage.id,
        )
      ) {
        return previousMessages;
      }

      return [...previousMessages, nextMessage].sort(
        (leftMessage, rightMessage) =>
          leftMessage.timestamp - rightMessage.timestamp,
      );
    });
  }, []);

  useEffect(() => {
    void start({
      displayName: deviceDisplayName,
      debug: __DEV__,
      onMessage: handleInboundMessage,
    });

    return () => {
      void stop();
    };
  }, [start, stop, deviceDisplayName, handleInboundMessage]);

  const activePeer = activePeerId ? getPeer(activePeerId) : undefined;

  const peerMessages = useMemo(() => {
    if (!activePeer?.clientId) {
      return messages;
    }

    return messages.filter(
      (message) => message.outgoing || message.senderId === activePeer.clientId,
    );
  }, [activePeer, messages]);

  const peersWithPreview = useMemo(() => {
    const previewBySenderId = new Map<
      string,
      { text: string; timestamp: number }
    >();

    for (const message of messages) {
      const existingPreview = previewBySenderId.get(message.senderId);
      if (!existingPreview || message.timestamp > existingPreview.timestamp) {
        previewBySenderId.set(message.senderId, {
          text: message.text,
          timestamp: message.timestamp,
        });
      }
    }

    return peers.map((peer) => {
      const preview = peer.clientId
        ? previewBySenderId.get(peer.clientId)
        : undefined;
      return {
        peer,
        previewText: preview?.text,
        previewAt: preview?.timestamp,
      };
    });
  }, [messages, peers]);

  const meshStatus = useMemo(() => {
    if (error) {
      return error;
    }

    if (status === "permissions_denied") {
      return "Bluetooth permissions are required.";
    }

    if (!isReady) {
      return "Starting mesh…";
    }

    return `Mesh active · ${connectedPeerCount} link${connectedPeerCount === 1 ? "" : "s"}`;
  }, [connectedPeerCount, error, isReady, status]);

  const handleSendMessage = async (text: string) => {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return;
    }

    const timestamp = Date.now();
    setMessages((previousMessages) => [
      ...previousMessages,
      {
        id: `local-${timestamp}`,
        text: trimmedText,
        timestamp,
        outgoing: true,
        senderId: "local",
        displayName: localDisplayName,
      },
    ]);

    await broadcast(
      JSON.stringify({
        type: "chat",
        text: trimmedText,
      } satisfies ChatWireMessage),
    );
  };

  return (
    <View style={styles.container}>
      {activePeer && activePeerId ? (
        <ChatScreen
          peer={activePeer}
          messages={peerMessages}
          onBack={() => setActivePeerId(null)}
          onSendMessage={handleSendMessage}
        />
      ) : (
        <HomeScreen
          localDisplayName={localDisplayName}
          peersWithPreview={peersWithPreview}
          meshStatus={meshStatus}
          isReady={isReady}
          onSelectPeer={setActivePeerId}
        />
      )}
      <StatusBar style="light" />
    </View>
  );
}

export default function App() {
  return (
    <MeshProvider>
      <MeshChatApp />
    </MeshProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
});
