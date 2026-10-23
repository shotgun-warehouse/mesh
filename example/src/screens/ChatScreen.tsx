import { useMemo, useState } from "react";
import * as ImagePicker from "expo-image-picker";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ImageBubble } from "../components/ImageBubble";
import { ImageComposer } from "../components/ImageComposer";
import type { EncodedImage, SourceImage } from "../images";
import type { MeshPeer } from "../types";

import type { ChatMessage } from "../types";

const ANDROID_NAV_BAR_PADDING = 50;

type ChatScreenProps = {
  peer: MeshPeer;
  messages: ChatMessage[];
  onBack: () => void;
  onSendMessage: (text: string) => Promise<void>;
  onSendImage: (image: EncodedImage) => Promise<void>;
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
        {message.kind === "image" ? (
          <ImageBubble image={message.image} outgoing={message.outgoing} />
        ) : (
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
        )}
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
  onSendImage,
}: ChatScreenProps) {
  const [draftText, setDraftText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [pickedImage, setPickedImage] = useState<SourceImage | null>(null);

  const sortedMessages = useMemo(
    () =>
      [...messages].sort(
        (leftMessage, rightMessage) =>
          leftMessage.timestamp - rightMessage.timestamp,
      ),
    [messages],
  );

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

  const handlePickImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 1,
      });
      const asset = result.canceled ? undefined : result.assets[0];
      if (asset) {
        setPickedImage({
          uri: asset.uri,
          width: asset.width,
          height: asset.height,
        });
      }
    } catch (pickError) {
      Alert.alert("Could not open photos", String(pickError));
    }
  };

  const handleSendImage = async (image: EncodedImage) => {
    setIsSending(true);
    try {
      await onSendImage(image);
      setPickedImage(null);
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
          <Text style={styles.headerTitle}>{peer.displayName}</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {peer.id}
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
              Say hello. Messages sync over BLE to every device nearby, even
              ones that join later.
            </Text>
          </View>
        }
        renderItem={({ item: message }) => <MessageBubble message={message} />}
      />

      {pickedImage ? (
        <ImageComposer
          source={pickedImage}
          isSending={isSending}
          onCancel={() => setPickedImage(null)}
          onSend={(image) => void handleSendImage(image)}
        />
      ) : null}

      <View
        style={[
          styles.composer,
          pickedImage ? styles.composerAttached : null,
          Platform.OS === "android" ? styles.composerAndroid : null,
        ]}
      >
        <Pressable
          onPress={() => void handlePickImage()}
          disabled={isSending}
          style={({ pressed }) => [
            styles.attachButton,
            isSending ? styles.sendButtonDisabled : null,
            pressed ? styles.sendButtonPressed : null,
          ]}
        >
          <Text style={styles.attachLabel}>📷</Text>
        </Pressable>
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
  composerAttached: {
    borderTopWidth: 0,
  },
  attachButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
  },
  attachLabel: {
    fontSize: 20,
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
