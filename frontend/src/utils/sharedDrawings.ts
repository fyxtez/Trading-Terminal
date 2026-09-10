import { isTauri } from "@tauri-apps/api/core";
import { isLocalBrowserRuntime, TRADING_API_BASE_URL } from "../config/constants";
import { tradingApiFetch, tradingApiHeaders } from "../trading/api/http";
import { sanitizeDrawings } from "./drawings";
import type { Drawing } from "../types/drawing";

type Patch = { upserts: Drawing[]; deleted: string[]; seed?: boolean };
type Document = { revision: number; items: Record<string, Drawing | null> };
const manual = (items: Drawing[]) => items.filter((d) => !(d.type === "horizontal" && d.orderSide));
export function drawingPatch(before: Drawing[], after: Drawing[]): Patch {
  const previous = new Map(manual(before).map((d) => [d.id, JSON.stringify(d)]));
  const next = manual(after);
  const ids = new Set(next.map((d) => d.id));
  return {
    upserts: next.filter((d) => previous.get(d.id) !== JSON.stringify(d)),
    deleted: [...previous.keys()].filter((id) => !ids.has(id)),
  };
}

class SharedDocument {
  listeners = new Set<(drawings: Drawing[]) => void>();
  pending = new Map<string, Drawing | null>();
  initial: Drawing[];
  seeded = false;
  busy = false;
  revision = -1;
  timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    readonly symbol: string,
    initial: Drawing[],
  ) {
    this.initial = manual(initial);
    try {
      const saved = JSON.parse(localStorage.getItem(this.queueKey) ?? "[]");
      for (const [id, drawing] of saved) this.pending.set(id, drawing);
    } catch {
      /* Keep the chart's local copy if storage is unavailable. */
    }
  }
  get queueKey() {
    return `fyxtez:drawing-sync-pending:${this.symbol}`;
  }
  persist() {
    try {
      localStorage.setItem(this.queueKey, JSON.stringify([...this.pending]));
    } catch {
      /* Best effort. */
    }
  }
  enqueue(patch: Patch) {
    for (const d of patch.upserts) this.pending.set(d.id, d);
    for (const id of patch.deleted) this.pending.set(id, null);
    this.persist();
    this.schedule(300);
  }
  schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delay);
  }
  async request(patch?: Patch): Promise<Document> {
    const response = await tradingApiFetch(
      `${TRADING_API_BASE_URL}/api/chart-drawings/${encodeURIComponent(this.symbol)}`,
      {
        method: patch ? "PUT" : "GET",
        headers: tradingApiHeaders(patch ? { "Content-Type": "application/json" } : undefined),
        ...(patch ? { body: JSON.stringify(patch) } : {}),
      },
    );
    if (!response.ok) throw new Error("Drawing sync unavailable");
    const document = (await response.json()) as Document;
    if (!document.items || typeof document.revision !== "number")
      throw new Error("Invalid drawing document");
    return document;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.seeded) {
        await this.request({ upserts: this.initial, deleted: [], seed: true });
        this.seeded = true;
      }
      const sent = new Map(this.pending);
      const patch: Patch = {
        upserts: [...sent.values()].filter((d): d is Drawing => d !== null),
        deleted: [...sent].filter(([, d]) => d === null).map(([id]) => id),
      };
      const document = await this.request(sent.size ? patch : undefined);
      for (const [id, value] of sent) if (this.pending.get(id) === value) this.pending.delete(id);
      this.persist();
      // Edits made during this request win locally until their own request completes.
      const items = { ...document.items };
      for (const [id, value] of this.pending) items[id] = value;
      if (this.revision !== document.revision || sent.size) {
        this.revision = document.revision;
        const drawings = sanitizeDrawings(Object.values(items).filter(Boolean));
        for (const listener of this.listeners) listener(drawings);
      }
    } catch {
      // Preserve queued edits through disconnects; never overwrite local work
      // with an empty document when a request fails.
    } finally {
      this.busy = false;
      if (this.listeners.size || this.pending.size) this.schedule(this.pending.size ? 1000 : 2000);
      else documents.delete(this.symbol);
    }
  }
}
const documents = new Map<string, SharedDocument>();
export function connectSharedDrawings(
  symbol: string,
  initial: Drawing[],
  receive: (drawings: Drawing[]) => void,
) {
  if (!isTauri() && !isLocalBrowserRuntime()) return () => {};
  let document = documents.get(symbol);
  if (!document) {
    document = new SharedDocument(symbol, initial);
    documents.set(symbol, document);
  }
  document.listeners.add(receive);
  document.schedule(0);
  return () => {
    document.listeners.delete(receive);
    if (!document.listeners.size && !document.pending.size && !document.busy) {
      clearTimeout(document.timer);
      documents.delete(symbol);
    }
  };
}
export function publishSharedDrawings(symbol: string, before: Drawing[], after: Drawing[]) {
  const patch = drawingPatch(before, after);
  if (patch.upserts.length || patch.deleted.length) documents.get(symbol)?.enqueue(patch);
}
