import { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";

import { formatKilobytes, formatSeconds } from "../images";
import type { ImageTransfer } from "../types";

const BUBBLE_IMAGE_WIDTH = 220;

type ImageBubbleProps = {
  image: ImageTransfer;
  outgoing: boolean;
};

/** Stats lines under the photo: what a speed and consistency test needs to read off. */
function transferLines(image: ImageTransfer, outgoing: boolean): string[] {
  const parts = `${image.receivedCount}/${image.count} parts`;
  const size = formatKilobytes(image.bytes);

  if (outgoing) {
    if (image.completedAt === null) {
      return [`${size} · publishing ${parts}`];
    }
    return [
      `${size} · ${image.count} parts`,
      `Published in ${formatSeconds(image.completedAt - image.firstReceivedAt)}`,
    ];
  }

  if (image.completedAt === null) {
    return [
      `${size} · ${parts}`,
      `${formatSeconds(Date.now() - image.firstReceivedAt)} since the first part`,
    ];
  }

  const endToEndMs = image.completedAt - image.sentAt;
  const kilobytesPerSecond =
    image.bytes / 1024 / Math.max(endToEndMs / 1000, 0.001);
  return [
    `${size} · ${image.count} parts · ${image.isIntact ? "✓ intact" : "✗ corrupted"}`,
    `End to end ${formatSeconds(endToEndMs)} · ${kilobytesPerSecond.toFixed(1)} KB/s`,
    `First to last part ${formatSeconds(image.completedAt - image.firstReceivedAt)}`,
  ];
}

/** Re-renders every half second while `isActive`, so the elapsed time keeps counting. */
function useTicker(isActive: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isActive) {
      return;
    }
    const interval = setInterval(() => setTick((tick) => tick + 1), 500);
    return () => clearInterval(interval);
  }, [isActive]);
}

export function ImageBubble({ image, outgoing }: ImageBubbleProps) {
  useTicker(!outgoing && image.completedAt === null);
  const aspectRatio =
    image.width > 0 && image.height > 0 ? image.width / image.height : 1;
  const progress = image.receivedCount / Math.max(image.count, 1);

  return (
    <View>
      {image.base64 ? (
        <Image
          source={{ uri: `data:image/jpeg;base64,${image.base64}` }}
          style={[styles.image, { aspectRatio }]}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.image, styles.placeholder, { aspectRatio }]}>
          <View style={styles.progressTrack}>
            <View
              style={[styles.progressFill, { width: `${progress * 100}%` }]}
            />
          </View>
          <Text style={styles.placeholderLabel}>
            {image.receivedCount}/{image.count}
          </Text>
        </View>
      )}
      {transferLines(image, outgoing).map((line) => (
        <Text
          key={line}
          style={[
            styles.stat,
            !outgoing && image.isIntact === false ? styles.statError : null,
          ]}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    width: BUBBLE_IMAGE_WIDTH,
    borderRadius: 8,
    marginBottom: 6,
    backgroundColor: "#d1d7db",
  },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  progressTrack: {
    alignSelf: "stretch",
    height: 6,
    borderRadius: 3,
    backgroundColor: "#ffffff",
    overflow: "hidden",
  },
  progressFill: {
    height: 6,
    backgroundColor: "#128C7E",
  },
  placeholderLabel: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: "600",
    color: "#3b4a54",
  },
  stat: {
    fontSize: 12,
    lineHeight: 17,
    color: "#3b4a54",
    fontVariant: ["tabular-nums"],
  },
  statError: {
    color: "#c62828",
    fontWeight: "600",
  },
});
