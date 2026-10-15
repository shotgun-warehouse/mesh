import type { Item, ItemAction } from "./types";

export type Arrival = {
  at: number;
  /** Device the item arrived from; null when this device created it. */
  via: string | null;
  /** How it arrived: the author's flood, a repair answer, local creation, or the app's server. */
  channel: "local" | "flood" | "repair" | "server";
};

export type TicketState = { inside: boolean; head: Item | null };

function compareItems(left: Item, right: Item): number {
  if (left.createdAt !== right.createdAt)
    return left.createdAt - right.createdAt;
  if (left.author !== right.author) return left.author < right.author ? -1 : 1;
  return left.tid < right.tid ? -1 : left.tid > right.tid ? 1 : 0;
}

/**
 * The simulated app's own table of scans (Backstage's `syncActions` + `scanLogs`): what it
 * published and what `onItemsReceived` handed it. The ticket view is folded from the set, so two
 * devices holding the same scans show the same tickets whatever the arrival order. It survives
 * app kills (it stands for SQLite).
 */
export class Replica {
  readonly items = new Map<string, Item>();
  readonly arrivals = new Map<string, Arrival>();
  private readonly tickets = new Map<number, Item[]>();

  get size(): number {
    return this.items.size;
  }

  has(tid: string): boolean {
    return this.items.has(tid);
  }

  /** Adds a scan. Returns false when it was already there. */
  add(item: Item, arrival: Arrival): boolean {
    if (this.items.has(item.tid)) {
      return false;
    }
    this.items.set(item.tid, item);
    this.arrivals.set(item.tid, arrival);
    const ticketItems = this.tickets.get(item.ticketId) ?? [];
    let index = ticketItems.length;
    while (index > 0 && compareItems(ticketItems[index - 1]!, item) > 0) {
      index -= 1;
    }
    ticketItems.splice(index, 0, item);
    this.tickets.set(item.ticketId, ticketItems);
    return true;
  }

  /** The ticket folded from the set: inside after a scan, outside after a checkout. */
  ticketState(ticketId: number): TicketState {
    const ticketItems = this.tickets.get(ticketId);
    const head = ticketItems?.[ticketItems.length - 1] ?? null;
    return { inside: head?.action === "scan", head };
  }

  /** A new scan decided on this device's current view. */
  createLocal(
    tid: string,
    author: string,
    ticketId: number,
    action: ItemAction,
    createdAt: number,
  ): Item {
    const item: Item = {
      tid,
      author,
      ticketId,
      action,
      createdAt,
      prev: this.ticketState(ticketId).head?.tid ?? null,
    };
    this.add(item, { at: createdAt, via: null, channel: "local" });
    return item;
  }

  ticketView(): Map<number, boolean> {
    const view = new Map<number, boolean>();
    for (const [ticketId] of this.tickets) {
      view.set(ticketId, this.ticketState(ticketId).inside);
    }
    return view;
  }
}

/** A scan as item data: `[tid, ticket, action, createdAt, prev, pad]`. */
type ScanData = [string, number, 0 | 1, number, string | null, string];

/** Item data for a scan, padded to `itemBytes` so packets weigh what Backstage's weigh. */
export function encodeScan(item: Item, itemBytes: number): string {
  const data: ScanData = [
    item.tid,
    item.ticketId,
    item.action === "scan" ? 1 : 0,
    item.createdAt,
    item.prev,
    "",
  ];
  data[5] = "x".repeat(Math.max(0, itemBytes - JSON.stringify(data).length));
  return JSON.stringify(data);
}

export function decodeScan(data: string, author: string): Item | null {
  try {
    const [tid, ticketId, action, createdAt, prev] = JSON.parse(
      data,
    ) as ScanData;
    return {
      tid,
      author,
      ticketId,
      action: action === 1 ? "scan" : "checkout",
      createdAt,
      prev,
    };
  } catch {
    return null;
  }
}
