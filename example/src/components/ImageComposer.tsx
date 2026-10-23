import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  IMAGE_PRESETS,
  base64Bytes,
  chunkCount,
  encodeImage,
  formatKilobytes,
  type EncodedImage,
  type ImagePreset,
  type SourceImage,
} from "../images";

type ImageComposerProps = {
  source: SourceImage;
  isSending: boolean;
  onCancel: () => void;
  onSend: (image: EncodedImage) => void;
};

/** A picked photo before sending: choose its size and see what it costs on the mesh. */
export function ImageComposer({
  source,
  isSending,
  onCancel,
  onSend,
}: ImageComposerProps) {
  const [preset, setPreset] = useState<ImagePreset>(IMAGE_PRESETS[1]);
  const [encoded, setEncoded] = useState<EncodedImage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isCurrent = true;
    setEncoded(null);
    setError(null);
    encodeImage(source, preset)
      .then((image) => {
        if (isCurrent) setEncoded(image);
      })
      .catch((encodeError: unknown) => {
        if (isCurrent) setError(String(encodeError));
      });
    return () => {
      isCurrent = false;
    };
  }, [source, preset]);

  return (
    <View style={styles.container}>
      <View style={styles.preview}>
        {encoded ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${encoded.base64}` }}
            style={styles.thumbnail}
          />
        ) : (
          <View style={[styles.thumbnail, styles.thumbnailLoading]}>
            <ActivityIndicator color="#128C7E" />
          </View>
        )}
        <View style={styles.details}>
          <View style={styles.presets}>
            {IMAGE_PRESETS.map((option) => (
              <Pressable
                key={option.key}
                onPress={() => setPreset(option)}
                disabled={isSending}
                style={[
                  styles.preset,
                  option.key === preset.key ? styles.presetSelected : null,
                ]}
              >
                <Text
                  style={[
                    styles.presetLabel,
                    option.key === preset.key
                      ? styles.presetLabelSelected
                      : null,
                  ]}
                >
                  {option.label} · {option.maxSide}px
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.summary}>
            {error
              ? error
              : encoded
                ? `${encoded.width}×${encoded.height} · ${formatKilobytes(base64Bytes(encoded.base64))} · ${chunkCount(encoded.base64)} parts`
                : "Encoding…"}
          </Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={onCancel}
          disabled={isSending}
          style={styles.cancel}
        >
          <Text style={styles.cancelLabel}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={() => encoded && onSend(encoded)}
          disabled={!encoded || isSending}
          style={[
            styles.send,
            !encoded || isSending ? styles.sendDisabled : null,
          ]}
        >
          <Text style={styles.sendLabel}>
            {isSending ? "Sending…" : "Send photo"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingTop: 10,
    backgroundColor: "#f0f2f5",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#d1d7db",
  },
  preview: {
    flexDirection: "row",
    gap: 12,
  },
  thumbnail: {
    width: 72,
    height: 72,
    borderRadius: 8,
    backgroundColor: "#d1d7db",
  },
  thumbnailLoading: {
    alignItems: "center",
    justifyContent: "center",
  },
  details: {
    flex: 1,
    justifyContent: "center",
  },
  presets: {
    flexDirection: "row",
    gap: 6,
  },
  preset: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: "#ffffff",
  },
  presetSelected: {
    backgroundColor: "#128C7E",
  },
  presetLabel: {
    fontSize: 13,
    color: "#3b4a54",
    fontWeight: "600",
  },
  presetLabelSelected: {
    color: "#ffffff",
  },
  summary: {
    marginTop: 8,
    fontSize: 13,
    color: "#3b4a54",
    fontVariant: ["tabular-nums"],
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    paddingTop: 10,
  },
  cancel: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  cancelLabel: {
    fontSize: 15,
    color: "#667781",
    fontWeight: "600",
  },
  send: {
    backgroundColor: "#128C7E",
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  sendDisabled: {
    opacity: 0.45,
  },
  sendLabel: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
});
