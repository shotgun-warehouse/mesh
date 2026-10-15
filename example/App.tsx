import { useEffect, useMemo, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  MeshNotRunningError,
  MeshProvider,
  useMesh,
  useMeshMessages,
} from "@shotgunlive/mesh";

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
  const { broadcast, peers, getPeer } = useMesh();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);

  useMeshMessages((message) => {
    const wireMessage = parseChatWireMessage(message.json);
    if (!wireMessage) {
      return;
    }

    setMessages((previousMessages) => [
      ...previousMessages,
      {
        id: message.id,
        text: wireMessage.text,
        timestamp: message.timestamp,
        outgoing: false,
        senderId: message.senderId,
      },
    ]);
  });

  const activePeer = activePeerId ? getPeer(activePeerId) : undefined;

  // The peer left (or Bluetooth went off): go home, and don't reopen the chat when it comes back.
  useEffect(() => {
    if (activePeerId && !activePeer) {
      setActivePeerId(null);
    }
  }, [activePeerId, activePeer]);

  const peerMessages = useMemo(
    () =>
      messages.filter(
        (message) => message.outgoing || message.senderId === activePeer?.id,
      ),
    [activePeer, messages],
  );

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
      const preview = previewBySenderId.get(peer.id);
      return {
        peer,
        previewText: preview?.text,
        previewAt: preview?.timestamp,
      };
    });
  }, [messages, peers]);

  const handleSendMessage = async (text: string) => {
    try {
      await broadcast(
        JSON.stringify({ type: "chat", text } satisfies ChatWireMessage),
      );
    } catch (sendError) {
      Alert.alert(
        "Message not sent",
        sendError instanceof MeshNotRunningError
          ? "The mesh isn't running. Check the status on the home screen."
          : String(sendError),
      );
      return;
    }

    const timestamp = Date.now();
    setMessages((previousMessages) => [
      ...previousMessages,
      {
        id: `local-${timestamp}`,
        text,
        timestamp,
        outgoing: true,
        senderId: "local",
      },
    ]);
  };

  return (
    <View style={styles.container}>
      {activePeer ? (
        <ChatScreen
          peer={activePeer}
          messages={peerMessages}
          onBack={() => setActivePeerId(null)}
          onSendMessage={handleSendMessage}
        />
      ) : (
        <HomeScreen
          peersWithPreview={peersWithPreview}
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
