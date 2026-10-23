import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import type { ImageChunkWireMessage, ImageTransfer } from "./types";

/**
 * Base64 characters per chunk. An item's data is at most 4096 UTF-8 bytes (`MAX_ITEM_DATA_BYTES`);
 * the rest of the JSON envelope takes ~150.
 */
const CHUNK_CHARS = 3800;

/** Largest chunk count accepted from a peer (~3.7 MB of base64); L photos take ~30. */
const MAX_CHUNK_COUNT = 1000;

export type ImagePreset = {
  key: "small" | "medium" | "large";
  label: string;
  /** Longest side, in pixels. */
  maxSide: number;
  /** JPEG quality, 0–1. */
  quality: number;
};

export const IMAGE_PRESETS: ImagePreset[] = [
  { key: "small", label: "S", maxSide: 240, quality: 0.4 },
  { key: "medium", label: "M", maxSide: 480, quality: 0.5 },
  { key: "large", label: "L", maxSide: 960, quality: 0.6 },
];

export type EncodedImage = {
  base64: string;
  width: number;
  height: number;
};

export type SourceImage = {
  uri: string;
  width: number;
  height: number;
};

/** Downscales a picked photo to the preset and encodes it as JPEG. */
export async function encodeImage(
  source: SourceImage,
  preset: ImagePreset,
): Promise<EncodedImage> {
  const scale = Math.min(
    1,
    preset.maxSide / Math.max(source.width, source.height, 1),
  );
  const context = ImageManipulator.manipulate(source.uri).resize({
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  });
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({
    base64: true,
    compress: preset.quality,
    format: SaveFormat.JPEG,
  });
  if (!result.base64) {
    throw new Error("The image could not be encoded");
  }
  return { base64: result.base64, width: result.width, height: result.height };
}

export function chunkCount(base64: string): number {
  return Math.max(1, Math.ceil(base64.length / CHUNK_CHARS));
}

/** Decoded size of a base64 string, in bytes. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** 32-bit FNV-1a of the base64 text, as hex: the receiver checks the reassembled image with it. */
export function checksumOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function randomImageId(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
}

/** One synced item per chunk; every chunk carries the image's metadata. */
export function buildImageChunks(image: EncodedImage): ImageChunkWireMessage[] {
  const imageId = randomImageId();
  const count = chunkCount(image.base64);
  const checksum = checksumOf(image.base64);
  const sentAt = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    type: "image",
    imageId,
    index,
    count,
    width: image.width,
    height: image.height,
    bytes: base64Bytes(image.base64),
    checksum,
    sentAt,
    data: image.base64.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS),
  }));
}

export function parseImageChunk(
  parsed: Partial<ImageChunkWireMessage>,
): ImageChunkWireMessage | null {
  if (
    parsed.type !== "image" ||
    typeof parsed.imageId !== "string" ||
    !Number.isInteger(parsed.index) ||
    !Number.isInteger(parsed.count) ||
    typeof parsed.data !== "string" ||
    parsed.index === undefined ||
    parsed.count === undefined ||
    parsed.count < 1 ||
    parsed.count > MAX_CHUNK_COUNT ||
    parsed.index < 0 ||
    parsed.index >= parsed.count
  ) {
    return null;
  }
  return {
    type: "image",
    imageId: parsed.imageId,
    index: parsed.index,
    count: parsed.count,
    width: parsed.width ?? 0,
    height: parsed.height ?? 0,
    bytes: parsed.bytes ?? 0,
    checksum: parsed.checksum ?? "",
    sentAt: parsed.sentAt ?? 0,
    data: parsed.data,
  };
}

/** Adds one chunk to a transfer (a new one when `transfer` is undefined); duplicates are ignored. */
export function addImageChunk(
  transfer: ImageTransfer | undefined,
  chunk: ImageChunkWireMessage,
  receivedAt: number,
): ImageTransfer {
  const current: ImageTransfer = transfer ?? {
    imageId: chunk.imageId,
    count: chunk.count,
    width: chunk.width,
    height: chunk.height,
    bytes: chunk.bytes,
    checksum: chunk.checksum,
    sentAt: chunk.sentAt,
    chunks: Array.from({ length: chunk.count }, () => null),
    receivedCount: 0,
    firstReceivedAt: receivedAt,
    completedAt: null,
    base64: null,
    isIntact: null,
  };

  if (current.chunks[chunk.index] !== null) {
    return current;
  }

  const chunks = [...current.chunks];
  chunks[chunk.index] = chunk.data;
  const receivedCount = current.receivedCount + 1;
  const isComplete = receivedCount === current.count;
  const base64 = isComplete ? chunks.join("") : null;

  return {
    ...current,
    chunks,
    receivedCount,
    completedAt: isComplete ? receivedAt : null,
    base64,
    isIntact: base64 === null ? null : checksumOf(base64) === current.checksum,
  };
}

export function formatKilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} s`;
}
