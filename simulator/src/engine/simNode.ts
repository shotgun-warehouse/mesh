import { createUuid } from "@mesh/ids";
import type { MeshLogLevel, MeshLogger } from "@mesh/logger";
import { MeshRouter } from "@mesh/router";
import { MeshItemSync } from "@sync/itemSync";
import type {
  MeshItemArrival,
  MeshSyncExchange,
  MeshSyncOptions,
} from "@sync/sync";
import type { MeshItem } from "@sync/types";

import { createMemoryPersistence } from "./memoryPersistence";
import type { MediumDevice } from "./medium";
import { decodeScan, encodeScan, Replica, type Arrival } from "./replica";
import { SimTransport, type TransportWorld } from "./simTransport";
import type {
  DevicePlatform,
  DeviceSpec,
  Item,
  ItemAction,
  NetworkParams,
  Point,
  PowerState,
} from "./types";

const MAX_EXPLANATIONS = 40;
/** Every simulated device syncs the same event. */
export const SIM_SYNC_SCOPE = "sim-event";

/** What a node needs from the engine, beyond what its transport needs. */
export type NodeWorld = TransportWorld & {
  params(): NetworkParams;
  syncOptions(): MeshSyncOptions;
  deviceIdOfMesh(meshId: string): string | undefined;
  log(
    deviceId: string,
    tag: string,
    message: string,
    detail: Record<string, unknown> | undefined,
    level: MeshLogLevel,
  ): void;
  onItemCreated(node: SimNode, item: Item): void;
  onItemPublished(node: SimNode, item: Item, meshItem: MeshItem): void;
  onItemArrived(node: SimNode, item: Item, arrival: Arrival): void;
};

export type PowerSpan = { from: number; to: number | null; power: PowerState };

/**
 * One virtual phone: the real `MeshRouter` and the library's item sync (`MeshItemSync`) on a
 * `SimTransport`, plus the app's own table of scans.
 */
export class SimNode implements MediumDevice {
  readonly id: string;
  label: string;
  position: Point;
  platform: DevicePlatform;
  power: PowerState = "bluetoothOff";
  clockSkewMs: number;
  maxLinksOverride: number | undefined;
  meshId: string;
  /** The app's `syncScope` (survives app kills, like the app's own state). */
  syncScope: string | null;
  readonly transport: SimTransport;
  /** The app's database (scans it published or received). */
  replica = new Replica();
  /** The library's item sync; rebuilt when the app process restarts. */
  itemSync: MeshItemSync;
  router: MeshRouter | null = null;
  peerCount = 0;
  readonly explanations: MeshSyncExchange[] = [];
  readonly powerHistory: PowerSpan[] = [];
  private persistence = createMemoryPersistence().persistence;
  /** Duplicate receptions counted by item syncs this node has replaced (app restarts). */
  private retiredDuplicates = 0;
  private readonly logger: MeshLogger;

  constructor(
    private readonly world: NodeWorld,
    spec: DeviceSpec,
    meshId: string,
  ) {
    this.id = spec.id;
    this.label = spec.label;
    this.position = { ...spec.position };
    this.platform = spec.platform;
    this.clockSkewMs = spec.clockSkewMs ?? 0;
    this.maxLinksOverride = spec.maxLinks;
    this.meshId = meshId;
    this.syncScope =
      spec.syncScope === undefined ? SIM_SYNC_SCOPE : spec.syncScope;
    this.transport = new SimTransport(world, spec.id);
    this.logger = (tag, message, detail, level = "info") => {
      this.world.log(this.id, tag, message, detail, level);
    };
    this.itemSync = this.createItemSync();
  }

  get maxLinks(): number {
    return this.maxLinksOverride ?? this.world.params().maxLinks[this.platform];
  }

  /** Sets the power state. Links must already be dropped (the engine does it) when leaving `on`. */
  async setPower(next: PowerState): Promise<void> {
    const previous = this.power;
    if (previous === next) {
      return;
    }
    const now = this.world.now();
    const current = this.powerHistory[this.powerHistory.length - 1];
    if (current && current.to === null) current.to = now;
    this.powerHistory.push({ from: now, to: null, power: next });
    this.power = next;

    if (next === "on") {
      await this.startRouter();
      return;
    }

    this.transport.powerDown();
    this.itemSync.detach();
    await this.router?.stop();
    this.peerCount = 0;
    if (next === "appKilled") {
      // In-memory state dies with the process: dedup cache, queues, sync state. The item file
      // and the app's database survive.
      this.router = null;
      this.retiredDuplicates += this.itemSync.items.duplicates;
      this.itemSync = this.createItemSync();
    }
  }

  /** Items received that this device already held (flooding waste), over the whole run. */
  get duplicateReceptions(): number {
    return this.retiredDuplicates + this.itemSync.items.duplicates;
  }

  /** A factory reset: new mesh ID, empty disk. The engine power-cycles the node around it. */
  resetIdentity(meshId: string): void {
    this.meshId = meshId;
    this.persistence = createMemoryPersistence().persistence;
    this.replica = new Replica();
    this.router = null;
    this.retiredDuplicates += this.itemSync.items.duplicates;
    this.itemSync = this.createItemSync();
    this.explanations.length = 0;
  }

  onLinkUp(peerId: string): void {
    if (this.power !== "on") return;
    this.transport.emitPeerConnected(peerId);
  }

  onLinkDown(peerId: string): void {
    if (this.power !== "on") return;
    this.transport.emitPeerDisconnected(peerId);
  }

  /** A staff member scans a ticket on this device (online or not). */
  scan(ticketId: number, action: ItemAction): Item {
    const item = this.replica.createLocal(
      createUuid(),
      this.meshId,
      ticketId,
      action,
      this.world.now() + this.clockSkewMs,
    );
    this.world.onItemCreated(this, item);
    const itemSync = this.itemSync;
    itemSync
      .publish(encodeScan(item, this.world.params().itemBytes), item.createdAt)
      .then((meshItem) => this.world.onItemPublished(this, item, meshItem))
      .catch((error: unknown) => {
        this.logger(
          "sim",
          "publishItem failed",
          { message: error instanceof Error ? error.message : String(error) },
          "error",
        );
      });
    return item;
  }

  /** The app switches events (`syncScope` prop). */
  setScope(scope: string | null): Promise<void> {
    this.syncScope = scope;
    return this.itemSync.setScope(scope);
  }

  /**
   * The app pulled `items` from its server: seed the library's set (`addItems`) and the app's own
   * table. Only for the current scope.
   */
  async seed(items: MeshItem[]): Promise<void> {
    if (this.syncScope === null) {
      throw new Error(`${this.label} has no sync scope to seed`);
    }
    await this.itemSync.addItems(this.syncScope, items);
    for (const meshItem of items) {
      const item = decodeScan(meshItem.data, meshItem.author);
      if (!item) continue;
      const at: Arrival = {
        at: this.world.now(),
        via: null,
        channel: "server",
      };
      if (this.replica.add(item, at)) {
        this.world.onItemArrived(this, item, at);
      }
    }
  }

  /** Router internals the inspector shows. Read through the private fields on purpose. */
  routerInternals(): { pendingQueue: number; dedupSize: number } | null {
    if (!this.router) return null;
    const router = this.router as unknown as {
      pendingWirePayloads: unknown[];
      seenPacketIds: Set<string>;
    };
    return {
      pendingQueue: router.pendingWirePayloads.length,
      dedupSize: router.seenPacketIds.size,
    };
  }

  private createItemSync(): MeshItemSync {
    const itemSync = new MeshItemSync({
      deviceId: this.meshId,
      persistence: this.persistence,
      syncOptions: () => this.world.syncOptions(),
      onItems: (items, arrival) => this.receiveItems(items, arrival),
      onExchange: (exchange) => {
        this.explanations.push(exchange);
        if (this.explanations.length > MAX_EXPLANATIONS)
          this.explanations.shift();
      },
      log: this.logger,
    });
    void itemSync.setScope(this.syncScope);
    return itemSync;
  }

  private async startRouter(): Promise<void> {
    if (!this.router) {
      this.router = this.createRouter();
    }
    const router = this.router;
    await router.start();
    // Power may have changed while the router was starting.
    if (this.power === "on" && this.router === router) {
      this.itemSync.attach(router);
    }
  }

  private createRouter(): MeshRouter {
    return new MeshRouter(
      this.meshId,
      this.label,
      {
        onIdentity: () => {},
        onLinkConnected: (event) => {
          if (event.deviceId) this.itemSync.neighbourUp(event.deviceId);
        },
        onLinkDisconnected: (event) => {
          if (event.deviceId) this.itemSync.neighbourDown(event.deviceId);
        },
        onPeerCountChange: (connectedPeerCount) => {
          this.peerCount = connectedPeerCount;
        },
        onSyncPacket: (packet, linkDeviceId) => {
          this.itemSync.handlePacket(packet, linkDeviceId);
        },
      },
      { transport: this.transport, logger: this.logger },
    );
  }

  /** The app's `onItemsReceived`: store the scans in its own table. */
  private receiveItems(items: MeshItem[], arrival: MeshItemArrival): void {
    for (const meshItem of items) {
      const item = decodeScan(meshItem.data, meshItem.author);
      if (!item) {
        this.logger(
          "sim",
          "Received an item that is not a scan",
          undefined,
          "warn",
        );
        continue;
      }
      const at: Arrival = {
        at: this.world.now(),
        via: arrival.linkDeviceId
          ? (this.world.deviceIdOfMesh(arrival.linkDeviceId) ?? null)
          : null,
        channel: arrival.channel,
      };
      if (this.replica.add(item, at)) {
        this.world.onItemArrived(this, item, at);
      }
    }
  }
}
