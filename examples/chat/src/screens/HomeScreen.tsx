import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { formatShortId, getPeerLabel, type MeshPeer } from "@shotgun/mesh";

type PeerPreview = {
  peer: MeshPeer;
  previewText?: string;
  previewAt?: number;
};

type HomeScreenProps = {
  localDisplayName: string;
  peersWithPreview: PeerPreview[];
  meshStatus: string;
  isReady: boolean;
  onSelectPeer: (peerId: string) => void;
};

function formatActivityTime(timestamp?: number): string {
  if (!timestamp) {
    return "";
  }

  const activityDate = new Date(timestamp);
  return activityDate.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PeerRow({
  peerPreview,
  onPress,
}: {
  peerPreview: PeerPreview;
  onPress: () => void;
}) {
  const { peer, previewText, previewAt } = peerPreview;
  const peerLabel = getPeerLabel(peer);
  const preview = previewText
    ? previewText
    : peer.isIdentified
      ? "Nearby device · tap to open chat"
      : "Connecting · tap to open chat";

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.peerRow,
        pressed ? styles.peerRowPressed : null,
      ]}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarLabel}>{peerLabel[0]}</Text>
      </View>
      <View style={styles.peerContent}>
        <View style={styles.peerHeader}>
          <Text style={styles.peerName} numberOfLines={1}>
            {peerLabel}
          </Text>
          <Text style={styles.peerTime}>
            {formatActivityTime(previewAt ?? peer.lastSeen)}
          </Text>
        </View>
        <Text style={styles.peerPreview} numberOfLines={1}>
          {preview}
        </Text>
        <Text style={styles.peerMeta} numberOfLines={1}>
          {peer.isIdentified && peer.clientId
            ? formatShortId(peer.clientId)
            : "Connecting…"}{" "}
          · {peer.rssi} dBm
        </Text>
      </View>
    </Pressable>
  );
}

export function HomeScreen({
  localDisplayName,
  peersWithPreview,
  meshStatus,
  isReady,
  onSelectPeer,
}: HomeScreenProps) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Shotgun Mesh</Text>
        <Text style={styles.headerSubtitle}>You · {localDisplayName}</Text>
      </View>

      {!isReady ? (
        <View style={styles.loadingState}>
          <ActivityIndicator color="#ffffff" />
          <Text style={styles.loadingText}>{meshStatus}</Text>
        </View>
      ) : null}

      <FlatList
        data={peersWithPreview}
        keyExtractor={(peerPreview) => peerPreview.peer.bleDeviceId}
        contentContainerStyle={
          peersWithPreview.length === 0 ? styles.emptyListContent : undefined
        }
        ListEmptyComponent={
          isReady ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No nearby devices yet</Text>
              <Text style={styles.emptyBody}>
                Open the app on another phone nearby. Devices appear here as
                soon as a BLE link is established, then update with identity.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item: peerPreview }) => (
          <PeerRow
            peerPreview={peerPreview}
            onPress={() => onSelectPeer(peerPreview.peer.id)}
          />
        )}
      />

      {isReady ? (
        <View style={styles.footer}>
          <Text style={styles.footerText}>{meshStatus}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  header: {
    paddingTop: 64,
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: "#075E54",
  },
  headerTitle: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "700",
  },
  headerSubtitle: {
    marginTop: 4,
    color: "#d9fdd3",
    fontSize: 14,
  },
  loadingState: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: "#128C7E",
  },
  loadingText: {
    color: "#ffffff",
    fontSize: 14,
  },
  peerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ece5dd",
    backgroundColor: "#ffffff",
  },
  peerRowPressed: {
    backgroundColor: "#f5f6f6",
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#dfe5e7",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  avatarLabel: {
    fontSize: 22,
    fontWeight: "700",
    color: "#54656f",
    textTransform: "uppercase",
  },
  peerContent: {
    flex: 1,
  },
  peerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  peerName: {
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
    color: "#111b21",
  },
  peerTime: {
    fontSize: 12,
    color: "#667781",
  },
  peerPreview: {
    marginTop: 4,
    fontSize: 15,
    color: "#667781",
  },
  peerMeta: {
    marginTop: 2,
    fontSize: 12,
    color: "#8696a0",
  },
  emptyListContent: {
    flexGrow: 1,
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
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#ece5dd",
    backgroundColor: "#f0f2f5",
  },
  footerText: {
    fontSize: 12,
    color: "#667781",
    textAlign: "center",
  },
});
