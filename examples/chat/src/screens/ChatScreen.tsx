import { useMemo, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { formatShortId, getPeerLabel, type MeshPeer } from "@shotgun/mesh";

import type { ChatMessage } from "../types";

const ANDROID_NAV_BAR_PADDING = 50;

type ChatScreenProps = {
  peer: MeshPeer;
  messages: ChatMessage[];
  onBack: () => void;
  onSendMessage: (text: string) => Promise<void>;
};

function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <View
      style={[
        styles.messageRow,
        message.outgoing
          ? styles.messageRowOutgoing
          : styles.messageRowIncoming,
      ]}
    >
      <View
        style={[
          styles.messageBubble,
          message.outgoing
            ? styles.messageBubbleOutgoing
            : styles.messageBubbleIncoming,
        ]}
      >
        <Text
          style={[
            styles.messageText,
            message.outgoing
              ? styles.messageTextOutgoing
              : styles.messageTextIncoming,
          ]}
        >
          {message.text}
        </Text>
        <Text
          style={[
            styles.messageTime,
            message.outgoing
              ? styles.messageTimeOutgoing
              : styles.messageTimeIncoming,
          ]}
        >
          {formatMessageTime(message.timestamp)}
        </Text>
      </View>
    </View>
  );
}

export function ChatScreen({
  peer,
  messages,
  onBack,
  onSendMessage,
}: ChatScreenProps) {
  const [draftText, setDraftText] = useState("");
  const [isSending, setIsSending] = useState(false);

  const sortedMessages = useMemo(
    () =>
      [...messages].sort(
        (leftMessage, rightMessage) =>
          leftMessage.timestamp - rightMessage.timestamp,
      ),
    [messages],
  );

  const peerLabel = getPeerLabel(peer);

  const handleSend = async () => {
    const trimmedText = draftText.trim();
    if (!trimmedText || isSending) {
      return;
    }

    setIsSending(true);
    setDraftText("");

    try {
      await onSendMessage(trimmedText);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="padding"
      keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
    >
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <Text style={styles.backLabel}>‹</Text>
        </Pressable>
        <View style={styles.headerContent}>
          <Text style={styles.headerTitle}>{peerLabel}</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {peer.isIdentified && peer.clientId
              ? formatShortId(peer.clientId)
              : "Waiting for identity…"}
          </Text>
        </View>
      </View>

      <FlatList
        data={sortedMessages}
        keyExtractor={(message) => message.id}
        contentContainerStyle={styles.messagesContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No messages yet</Text>
            <Text style={styles.emptyBody}>
              Say hello. Messages are broadcast over BLE to nearby devices.
            </Text>
          </View>
        }
        renderItem={({ item: message }) => <MessageBubble message={message} />}
      />

      <View
        style={[
          styles.composer,
          Platform.OS === "android" ? styles.composerAndroid : null,
        ]}
      >
        <TextInput
          value={draftText}
          onChangeText={setDraftText}
          placeholder="Message"
          placeholderTextColor="#8696a0"
          style={styles.composerInput}
          multiline
          editable={!isSending}
        />
        <Pressable
          onPress={handleSend}
          disabled={!draftText.trim() || isSending}
          style={({ pressed }) => [
            styles.sendButton,
            !draftText.trim() || isSending ? styles.sendButtonDisabled : null,
            pressed && draftText.trim() && !isSending
              ? styles.sendButtonPressed
              : null,
          ]}
        >
          <Text style={styles.sendLabel}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#efeae2",
  },
  header: {
    paddingTop: 56,
    paddingBottom: 12,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#075E54",
  },
  backButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 4,
  },
  backLabel: {
    color: "#ffffff",
    fontSize: 32,
    lineHeight: 34,
    marginTop: -4,
  },
  headerContent: {
    flex: 1,
  },
  headerTitle: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "700",
  },
  headerSubtitle: {
    marginTop: 2,
    color: "#d9fdd3",
    fontSize: 13,
  },
  messagesContent: {
    paddingHorizontal: 12,
    paddingVertical: 16,
    flexGrow: 1,
  },
  messageRow: {
    marginBottom: 8,
    flexDirection: "row",
  },
  messageRowOutgoing: {
    justifyContent: "flex-end",
  },
  messageRowIncoming: {
    justifyContent: "flex-start",
  },
  messageBubble: {
    maxWidth: "80%",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  messageBubbleOutgoing: {
    backgroundColor: "#d9fdd3",
    borderTopRightRadius: 4,
  },
  messageBubbleIncoming: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 4,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  messageTextOutgoing: {
    color: "#111b21",
  },
  messageTextIncoming: {
    color: "#111b21",
  },
  messageTime: {
    marginTop: 4,
    fontSize: 11,
    alignSelf: "flex-end",
  },
  messageTimeOutgoing: {
    color: "#667781",
  },
  messageTimeIncoming: {
    color: "#8696a0",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingTop: 80,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#111b21",
  },
  emptyBody: {
    marginTop: 8,
    fontSize: 15,
    lineHeight: 22,
    color: "#667781",
    textAlign: "center",
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    backgroundColor: "#f0f2f5",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#d1d7db",
  },
  composerAndroid: {
    paddingBottom: 10 + ANDROID_NAV_BAR_PADDING,
  },
  composerInput: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#ffffff",
    fontSize: 16,
    color: "#111b21",
  },
  sendButton: {
    backgroundColor: "#128C7E",
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  sendButtonDisabled: {
    opacity: 0.45,
  },
  sendButtonPressed: {
    opacity: 0.85,
  },
  sendLabel: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
});
