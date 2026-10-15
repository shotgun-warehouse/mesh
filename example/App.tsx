import { useEffect, useMemo, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { MeshProvider, useMesh, type MeshItem } from "@shotgunlive/mesh";

import { ChatScreen } from "./src/screens/ChatScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import type { ChatMessage, ChatWireMessage } from "./src/types";

/** Every device running the example chats in one set. */
const CHAT_SYNC_SCOPE = "chat";

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

/** Chat messages are synced items: a device that joins later still gets the conversation. */
function toChatMessages(items: MeshItem[], outgoing: boolean): ChatMessage[] {
  return items.flatMap((item) => {
    const wireMessage = parseChatWireMessage(item.data);
    if (!wireMessage) {
      return [];
    }
    return [
      {
        id: `${item.author}:${item.seq}`,
        text: wireMessage.text,
        timestamp: item.createdAt,
        outgoing,
        senderId: item.author,
      },
    ];
  });
}

type MeshChatAppProps = {
  messages: ChatMessage[];
  onPublished: (item: MeshItem) => void;
};

function MeshChatApp({ messages, onPublished }: MeshChatAppProps) {
  const { publishItem, peers, getPeer } = useMesh();
  const [activePeerId, setActivePeerId] = useState<string | null>(null);

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
      const item = await publishItem(
        JSON.stringify({ type: "chat", text } satisfies ChatWireMessage),
      );
      onPublished(item);
    } catch (sendError) {
      Alert.alert("Message not sent", String(sendError));
    }
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
  // The mesh saves items, but this demo keeps its message list in memory only: after a restart it
  // shows what arrives from then on.
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const appendItems = (items: MeshItem[], outgoing: boolean) => {
    setMessages((previousMessages) => [
      ...previousMessages,
      ...toChatMessages(items, outgoing),
    ]);
  };

  return (
    <MeshProvider
      syncScope={CHAT_SYNC_SCOPE}
      onItemsReceived={(items) => appendItems(items, false)}
    >
      <MeshChatApp
        messages={messages}
        onPublished={(item) => appendItems([item], true)}
      />
    </MeshProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
});
