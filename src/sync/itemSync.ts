import { MAX_ITEM_DATA_BYTES } from "../mesh/constants";
import { isDeviceId } from "../mesh/ids";
import type { MeshLogger } from "../mesh/logger";
import type { MeshSessionPacket } from "../mesh/packets";
import type { MeshItemPersistence } from "./persistence";
import { itemDataBytes, MeshItemStore } from "./store";
import {
  MeshSync,
  resolveSyncOptions,
  type MeshItemArrival,
  type MeshSyncExchange,
  type MeshSyncLink,
  type MeshSyncOptions,
} from "./sync";
import { scopeHash, type MeshItem } from "./types";

export type MeshItemSyncOptions = {
  deviceId: string;
  persistence: MeshItemPersistence;
  /** Knobs, read live. */
  syncOptions: () => MeshSyncOptions | undefined;
  /** New items from peers (already saved), each delivered once. */
  onItems: (items: MeshItem[], arrival: MeshItemArrival) => void;
  onExchange?: (exchange: MeshSyncExchange) => void;
  log: MeshLogger;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scopeLabel(scope: string | null): string {
  return scope === null ? "none" : `"${scope}"`;
}

/** Throws on the first item that cannot be in a set. */
function validateItems(items: MeshItem[]): void {
  for (const item of items) {
    if (!isDeviceId(item.author)) {
      throw new Error(`Item author "${item.author}" is not a device ID`);
    }
    if (!Number.isInteger(item.seq) || item.seq < 1) {
      throw new Error(
        `Item ${item.author}:${item.seq} has an invalid seq (an integer from 1)`,
      );
    }
    if (!Number.isFinite(item.createdAt)) {
      throw new Error(`Item ${item.author}:${item.seq} has no valid createdAt`);
    }
    const bytes = itemDataBytes(item.data);
    if (bytes > MAX_ITEM_DATA_BYTES) {
      throw new Error(
        `Item ${item.author}:${item.seq} data is ${bytes} bytes; the limit is ${MAX_ITEM_DATA_BYTES} (MAX_ITEM_DATA_BYTES).`,
      );
    }
  }
}

/**
 * Everything item sync needs on one device: the current scope's set (loaded from and appended to
 * persistence), and the `MeshSync` of the running mesh session, if any. Sessions come and go
 * (Bluetooth off and on); the set stays. With no scope (`null`) there is no set and no
 * `MeshSync`: sync packets are ignored and nothing is sent.
 */
export class MeshItemSync {
  private scope: string | null = null;
  private store = new MeshItemStore();
  private loading: Promise<void> = Promise.resolve();
  private link: MeshSyncLink | null = null;
  private sync: MeshSync | null = null;
  /** Neighbours whose link is up, so a new `MeshSync` (scope switch) compares with them at once. */
  private readonly neighbours = new Set<string>();
  /** Appends run one after another so the file keeps arrival order. */
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: MeshItemSyncOptions) {}

  get currentScope(): string | null {
    return this.scope;
  }

  /** The current scope's set (the simulator reads it for metrics). */
  get items(): MeshItemStore {
    return this.store;
  }

  /** Switches to `scope`: loads its set and restarts sync on it. `null` turns sync off. */
  setScope(scope: string | null): Promise<void> {
    if (scope === this.scope) {
      return this.loading;
    }
    this.scope = scope;
    this.stopSync();
    const store = new MeshItemStore();
    this.store = store;
    if (scope === null) {
      this.loading = Promise.resolve();
      return this.loading;
    }
    this.loading = this.options.persistence
      .load(scope)
      .then(({ items, seqFloors }) => {
        store.add(items);
        store.reserveSeq(
          this.options.deviceId,
          seqFloors[this.options.deviceId] ?? 0,
        );
        store.duplicates = 0;
      })
      .catch((error: unknown) => {
        this.options.log(
          "sync",
          "Could not load items",
          { scope, message: errorMessage(error) },
          "error",
        );
      })
      .then(() => {
        if (this.scope === scope && this.store === store && this.link) {
          this.startSync(this.link);
        }
      });
    return this.loading;
  }

  /** Resolves once the current scope's set is loaded. */
  ready(): Promise<void> {
    return this.loading;
  }

  /** Adds an item to the set, persists it, then floods it if a session is running. */
  async publish(data: string, createdAt: number): Promise<MeshItem> {
    await this.loading;
    const scope = this.scope;
    if (scope === null) {
      throw new Error("No sync scope: publishItem needs a syncScope");
    }
    const store = this.store;
    const item = store.createLocal(this.options.deviceId, data, createdAt);
    await this.persist(scope, [item]);
    if (this.store === store) {
      this.sync?.push(item);
    }
    return item;
  }

  /**
   * Adds items the app already holds elsewhere (its server) to `scope`'s set and saves the new
   * ones. They are not handed to `onItems` and not flooded: repair serves them to neighbours that
   * ask, and stops asking neighbours for them. Rejects, storing nothing, when an item is invalid
   * or `scope` is not (or stops being, while the set loads) the current scope.
   */
  async addItems(scope: string, items: MeshItem[]): Promise<void> {
    if (scope !== this.scope) {
      throw new Error(
        `addItems is for scope "${scope}" but the current syncScope is ${scopeLabel(this.scope)}`,
      );
    }
    validateItems(items);
    const store = this.store;
    await this.loading;
    if (this.scope !== scope || this.store !== store) {
      throw new Error(
        `The syncScope changed from "${scope}" to ${scopeLabel(this.scope)} while addItems waited for it to load`,
      );
    }
    // Seeded copies are not flooding waste: keep the duplicate count about the mesh.
    const duplicates = store.duplicates;
    const added = store.add(items);
    store.duplicates = duplicates;
    if (added.length > 0) {
      await this.persist(scope, added);
    }
  }

  /**
   * Deletes the items of every scope from disk, and the current scope's from memory, then syncs
   * the emptied set (repair fetches back what neighbours still hold). This device's next items
   * still number after its deleted ones, so they never reuse a seq peers may hold. Items published
   * or received once the set is emptied are kept.
   */
  async clear(): Promise<void> {
    let loading: Promise<void>;
    do {
      loading = this.loading;
      await loading;
    } while (loading !== this.loading);

    const deviceId = this.options.deviceId;
    const store = new MeshItemStore();
    store.reserveSeq(deviceId, this.store.highestSeq(deviceId));
    this.store = store;
    if (this.link) {
      this.startSync(this.link);
    }

    // After the appends already queued, before the ones of items added to the new set.
    const clearing = this.writes.then(() =>
      this.options.persistence.clearAll(),
    );
    this.writes = clearing.catch((error: unknown) => {
      this.options.log(
        "sync",
        "Could not clear items",
        { message: errorMessage(error) },
        "error",
      );
    });
    await clearing;
  }

  /** Compares with every neighbour now (when repair is on) instead of at the next beacons. */
  compareNow(): void {
    this.sync?.compareNow();
  }

  /** A mesh session started: sync on its router once the set is loaded. */
  attach(link: MeshSyncLink): void {
    this.link = link;
    // A scope switch meanwhile starts sync itself once its own set is loaded.
    const loading = this.loading;
    void loading.then(() => {
      if (this.link === link && this.loading === loading && !this.sync) {
        this.startSync(link);
      }
    });
  }

  /** The mesh session stopped: its links are gone. */
  detach(): void {
    this.link = null;
    this.neighbours.clear();
    this.stopSync();
  }

  neighbourUp(deviceId: string): void {
    this.neighbours.add(deviceId);
    this.sync?.neighbourUp(deviceId);
  }

  neighbourDown(deviceId: string): void {
    this.neighbours.delete(deviceId);
    this.sync?.neighbourDown(deviceId);
  }

  handlePacket(packet: MeshSessionPacket, linkDeviceId: string | null): void {
    this.sync?.handlePacket(packet, linkDeviceId);
  }

  private startSync(link: MeshSyncLink): void {
    const scope = this.scope;
    if (scope === null) {
      return;
    }
    this.stopSync();
    const sync = new MeshSync(
      scopeHash(scope),
      this.store,
      link,
      () => resolveSyncOptions(this.options.syncOptions()),
      {
        onItems: (items, arrival) => this.deliver(scope, items, arrival),
        onExchange: this.options.onExchange,
      },
      this.options.log,
    );
    this.sync = sync;
    sync.start();
    for (const deviceId of this.neighbours) {
      sync.neighbourUp(deviceId);
    }
  }

  private stopSync(): void {
    this.sync?.stop();
    this.sync = null;
  }

  /** Saves new items, then hands them to the app. */
  private deliver(
    scope: string,
    items: MeshItem[],
    arrival: MeshItemArrival,
  ): void {
    void this.persist(scope, items).catch(() => undefined);
    try {
      this.options.onItems(items, arrival);
    } catch (error) {
      this.options.log(
        "sync",
        "The onItemsReceived handler threw",
        { message: errorMessage(error) },
        "error",
      );
    }
  }

  private persist(scope: string, items: MeshItem[]): Promise<void> {
    const write = this.writes.then(() =>
      this.options.persistence.append(scope, items),
    );
    this.writes = write.catch((error: unknown) => {
      this.options.log(
        "sync",
        "Could not persist items",
        { scope, count: items.length, message: errorMessage(error) },
        "error",
      );
    });
    return write;
  }
}
