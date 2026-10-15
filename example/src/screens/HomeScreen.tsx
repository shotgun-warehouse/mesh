import { useState } from "react";
import {
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useMesh, type MeshPeer, type MeshStatus } from "@shotgunlive/mesh";

type PeerPreview = {
  peer: MeshPeer;
  previewText?: string;
  previewAt?: number;
};

type HomeScreenProps = {
  peersWithPreview: PeerPreview[];
  onSelectPeer: (peerId: string) => void;
};

function describeStatus(
  status: MeshStatus,
  error: string | null,
  connectedPeerCount: number,
): string {
  switch (status) {
    case "starting":
      return "Starting…";
    case "running":
      return connectedPeerCount === 0
        ? "Running · looking for nearby devices"
        : `Running · ${connectedPeerCount} nearby device${connectedPeerCount === 1 ? "" : "s"}`;
    case "bluetooth_off":
      return "Bluetooth is off. Turn it on to join the mesh.";
    case "permission_denied":
      return "Bluetooth access denied. Tap to allow it in Settings.";
    case "unsupported":
      return "This device doesn't support Bluetooth LE.";
    case "error":
      return `Couldn't start the mesh: ${error ?? "unknown error"}`;
  }
}

const STATUS_DOT_COLORS: Record<MeshStatus, string> = {
  starting: "#f5c542",
  running: "#25d366",
  bluetooth_off: "#ff6b6b",
  permission_denied: "#ff6b6b",
  unsupported: "#ff6b6b",
  error: "#ff6b6b",
};

function MeshHeader() {
  const { status, error, connectedPeerCount, displayName, setDisplayName } =
    useMesh();
  // null while not editing, so the field follows `displayName` otherwise.
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  return (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>Shotgun Mesh</Text>
      <View style={styles.nameRow}>
        <Text style={styles.headerSubtitle}>You · </Text>
        <TextInput
          value={nameDraft ?? displayName}
          onChangeText={setNameDraft}
          onEndEditing={() => {
            if (nameDraft !== null) {
              setDisplayName(nameDraft);
            }
            setNameDraft(null);
          }}
          returnKeyType="done"
          style={styles.nameInput}
        />
      </View>
      <Pressable
        disabled={status !== "permission_denied"}
        onPress={() => void Linking.openSettings()}
        style={styles.statusRow}
      >
        <View
          style={[
            styles.statusDot,
            { backgroundColor: STATUS_DOT_COLORS[status] },
          ]}
        />
        <Text style={styles.statusText}>
          {describeStatus(status, error, connectedPeerCount)}
        </Text>
      </Pressable>
    </View>
  );
}

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
  const preview = previewText ?? "Tap to open chat";

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.peerRow,
        pressed ? styles.peerRowPressed : null,
      ]}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarLabel}>{peer.displayName[0]}</Text>
      </View>
      <View style={styles.peerContent}>
        <View style={styles.peerHeader}>
          <Text style={styles.peerName} numberOfLines={1}>
            {peer.displayName}
          </Text>
          <Text style={styles.peerTime}>
            {formatActivityTime(previewAt ?? peer.lastSeen)}
          </Text>
        </View>
        <Text style={styles.peerPreview} numberOfLines={1}>
          {preview}
        </Text>
        <Text style={styles.peerMeta} numberOfLines={1}>
          {peer.id}
          {peer.rssi === null ? " · via other devices" : ` · ${peer.rssi} dBm`}
        </Text>
      </View>
    </Pressable>
  );
}

export function HomeScreen({
  peersWithPreview,
  onSelectPeer,
}: HomeScreenProps) {
  const { status } = useMesh();

  return (
    <View style={styles.container}>
      <MeshHeader />

      <FlatList
        data={peersWithPreview}
        keyExtractor={(peerPreview) => peerPreview.peer.id}
        contentContainerStyle={
          peersWithPreview.length === 0 ? styles.emptyListContent : undefined
        }
        ListEmptyComponent={
          status === "running" ? (
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
  nameRow: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
  },
  headerSubtitle: {
    color: "#d9fdd3",
    fontSize: 14,
  },
  nameInput: {
    flex: 1,
    padding: 0,
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  statusRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    flex: 1,
    color: "#ffffff",
    fontSize: 13,
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
});
