import {
  FRAGMENT_ASSEMBLY_TIMEOUT_MS,
  MAX_ASSEMBLED_MESSAGE_BYTES,
} from "./constants";
import { meshLog } from "./logger";
import type { MeshSessionPacket } from "./sessionTypes";

export type AssembledMessage = {
  senderId: string;
  recipientId: string | null;
  messageId: string;
  displayName?: string;
  text: string;
  ts: number;
};

type TransferAssembly = {
  senderId: string;
  recipientId: string | null;
  messageId: string;
  displayName?: string;
  fragmentCount: number;
  totalBytes: number;
  chunks: Map<number, Uint8Array>;
  startedAt: number;
};

export class FragmentAssembler {
  private transfers = new Map<string, TransferAssembly>();

  hasActiveTransfers(): boolean {
    this.pruneExpiredTransfers();
    return this.transfers.size > 0;
  }

  ingest(packet: MeshSessionPacket): AssembledMessage | null {
    if (
      packet.packetType !== "fragmentStart" &&
      packet.packetType !== "fragmentContinue" &&
      packet.packetType !== "fragmentEnd"
    ) {
      return null;
    }

    if (
      !packet.transferId ||
      packet.fragmentIndex === undefined ||
      !packet.chunkBytes
    ) {
      return null;
    }

    this.pruneExpiredTransfers();

    let transfer = this.transfers.get(packet.transferId);
    if (!transfer) {
      if (
        packet.packetType !== "fragmentStart" ||
        !packet.fragmentCount ||
        !packet.totalBytes ||
        !packet.messageId
      ) {
        return null;
      }

      transfer = {
        senderId: packet.senderId,
        recipientId: packet.recipientId,
        messageId: packet.messageId,
        displayName: packet.displayName,
        fragmentCount: packet.fragmentCount,
        totalBytes: packet.totalBytes,
        chunks: new Map<number, Uint8Array>(),
        startedAt: Date.now(),
      };
      this.transfers.set(packet.transferId, transfer);
      meshLog("fragment", "Started fragment assembly", {
        transferId: packet.transferId,
        messageId: packet.messageId,
        senderId: packet.senderId,
        fragmentCount: packet.fragmentCount,
        totalBytes: packet.totalBytes,
      });
    }

    transfer.chunks.set(packet.fragmentIndex, packet.chunkBytes);

    meshLog("fragment", "Stored fragment chunk", {
      transferId: packet.transferId,
      fragmentIndex: packet.fragmentIndex,
      receivedChunks: transfer.chunks.size,
      fragmentCount: transfer.fragmentCount,
      packetType: packet.packetType,
      chunkBytes: packet.chunkBytes.length,
    });

    if (transfer.chunks.size < transfer.fragmentCount) {
      return null;
    }

    const orderedChunks: Uint8Array[] = [];
    for (let index = 0; index < transfer.fragmentCount; index += 1) {
      const chunk = transfer.chunks.get(index);
      if (!chunk) {
        return null;
      }
      orderedChunks.push(chunk);
    }

    const totalLength = orderedChunks.reduce(
      (sum, chunk) => sum + chunk.length,
      0,
    );

    if (
      totalLength !== transfer.totalBytes ||
      totalLength > MAX_ASSEMBLED_MESSAGE_BYTES
    ) {
      meshLog(
        "fragment",
        "Fragment assembly failed — size mismatch or limit exceeded",
        {
          transferId: packet.transferId,
          messageId: transfer.messageId,
          expectedBytes: transfer.totalBytes,
          actualBytes: totalLength,
          maxBytes: MAX_ASSEMBLED_MESSAGE_BYTES,
        },
        "error",
      );
      this.transfers.delete(packet.transferId);
      return null;
    }

    const mergedBytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of orderedChunks) {
      mergedBytes.set(chunk, offset);
      offset += chunk.length;
    }

    this.transfers.delete(packet.transferId);

    meshLog("fragment", "Fragment assembly complete", {
      transferId: packet.transferId,
      messageId: transfer.messageId,
      textChars: mergedBytes.length,
      assemblyMs: Date.now() - transfer.startedAt,
    });

    return {
      senderId: transfer.senderId,
      recipientId: transfer.recipientId,
      messageId: transfer.messageId,
      displayName: transfer.displayName,
      text: new TextDecoder().decode(mergedBytes),
      ts: packet.ts,
    };
  }

  private pruneExpiredTransfers(): void {
    const now = Date.now();
    for (const [transferId, transfer] of this.transfers.entries()) {
      if (now - transfer.startedAt > FRAGMENT_ASSEMBLY_TIMEOUT_MS) {
        meshLog(
          "fragment",
          "Fragment assembly timed out",
          {
            transferId,
            messageId: transfer.messageId,
            receivedChunks: transfer.chunks.size,
            fragmentCount: transfer.fragmentCount,
            ageMs: now - transfer.startedAt,
          },
          "warn",
        );
        this.transfers.delete(transferId);
      }
    }
  }
}
