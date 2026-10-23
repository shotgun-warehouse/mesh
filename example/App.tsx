import { useEffect, useMemo, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { MeshProvider, useMesh, type MeshItem } from "@shotgunlive/mesh";

import {
  addImageChunk,
  buildImageChunks,
  parseImageChunk,
  type EncodedImage,
} from "./src/images";
import { ChatScreen } from "./src/screens/ChatScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import type {
  ChatMessage,
  ChatWireMessage,
  ImageChunkWireMessage,
} from "./src/types";

/** Every device running the example chats in one set. */
const CHAT_SYNC_SCOPE = "chat";

function parseChatWireMessage(json: string): ChatWireMessage | null {
  try {
    const parsed = JSON.parse(json) as Partial<ChatWireMessage>;
    if (parsed.type === "chat" && typeof parsed.text === "string") {
      return { type: "chat", text: parsed.text };
    }
    if (parsed.type === "image") {
      return parseImageChunk(parsed as Partial<ImageChunkWireMessage>);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Chat messages are synced items: a device that joins later still gets the conversation. A photo
 * is one item per chunk, gathered into one message as its chunks arrive (in any order).
 */
function applyItems(
  previousMessages: ChatMessage[],
  items: MeshItem[],
  outgoing: boolean,
): ChatMessage[] {
  const receivedAt = Date.now();
  let messages = previousMessages;

  for (const item of items) {
    const wireMessage = parseChatWireMessage(item.data);
    if (!wireMessage) {
      continue;
    }

    if (wireMessage.type === "chat") {
      messages = [
        ...messages,
        {
          kind: "text",
          id: `${item.author}:${item.seq}`,
          text: wireMessage.text,
          timestamp: item.createdAt,
          outgoing,
          senderId: item.author,
        },
      ];
      continue;
    }

    const id = `${item.author}:image:${wireMessage.imageId}`;
    const existingIndex = messages.findIndex((message) => message.id === id);
    const existing = existingIndex === -1 ? undefined : messages[existingIndex];
    const image = addImageChunk(
      existing?.kind === "image" ? existing.image : undefined,
      wireMessage,
      receivedAt,
    );
    const message: ChatMessage = {
      kind: "image",
      id,
      image,
      timestamp: Math.min(
        existing?.timestamp ?? item.createdAt,
        item.createdAt,
      ),
      outgoing,
      senderId: item.author,
    };
    messages =
      existingIndex === -1
        ? [...messages, message]
        : messages.map((previous, index) =>
            index === existingIndex ? message : previous,
          );
  }

  return messages;
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
          text: message.kind === "text" ? message.text : "📷 Photo",
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

  /** One item per chunk, published in order; the bubble fills in as each one is out. */
  const handleSendImage = async (image: EncodedImage) => {
    try {
      for (const chunk of buildImageChunks(image)) {
        onPublished(await publishItem(JSON.stringify(chunk)));
      }
    } catch (sendError) {
      Alert.alert("Photo not fully sent", String(sendError));
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
          onSendImage={handleSendImage}
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
    setMessages((previousMessages) =>
      applyItems(previousMessages, items, outgoing),
    );
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
