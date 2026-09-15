import { TRADING_API_BASE_URL_CHANGED_EVENT } from "../../config/constants";
import { DESKTOP_CREDENTIALS_CHANGED_EVENT } from "../../desktop/credentials";
import { getBinanceCooldown, recordBinanceCooldown } from "./binanceRateLimit";

let connectionRevision = 0;
let accessFailure: SnapshotReadError | null = null;
const resetConnection = () => {
  connectionRevision += 1;
  accessFailure = null;
};
window.addEventListener(TRADING_API_BASE_URL_CHANGED_EVENT, resetConnection);
window.addEventListener(DESKTOP_CREDENTIALS_CHANGED_EVENT, resetConnection);

export class SnapshotReadError extends Error {
  constructor(
    message: string,
    readonly retryAt = 0,
  ) {
    super(message);
    this.name = "SnapshotReadError";
  }
}

export function snapshotResponseError(response: Response, message: string): SnapshotReadError {
  // Older backends return Binance rejections as HTTP 422. Recognize the
  // exchange code as well as HTTP status so their readers also back off.
  if ([418, 429].includes(response.status) || /Binance API error -1003:/i.test(message)) {
    const status = response.status === 418 || /banned until/i.test(message) ? 418 : 429;
    const pause = recordBinanceCooldown(status, response.headers.get("retry-after"), message);
    return new SnapshotReadError(
      "Binance has temporarily limited updates for this IP. Waiting before retrying automatically.",
      pause.retryAt,
    );
  }
  if (/Binance API error -(2015|2014):/i.test(message)) {
    return new SnapshotReadError(message, Date.now() + 60_000);
  }
  return new SnapshotReadError(message, response.status === 404 ? Date.now() + 60_000 : 0);
}

function assertReadAllowed() {
  const pause = getBinanceCooldown();
  if (pause) {
    throw new SnapshotReadError(
      "Binance has temporarily limited updates for this IP. Waiting before retrying automatically.",
      pause.retryAt,
    );
  }
  if (accessFailure && Date.now() < accessFailure.retryAt) throw accessFailure;
}

function waitForReader<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    request.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

/** Shared GET snapshots: deduplicate readers, including cancelled components,
 * and keep failed reads from multiplying with each mounted chart or panel. */
export class SnapshotCache<T> {
  private revision = connectionRevision;
  private generation = 0;
  private cached: { value: T; at: number } | null = null;
  private pending: { request: Promise<T>; force: boolean; generation: number } | null = null;
  private failure: SnapshotReadError | null = null;
  private failures = 0;

  constructor(private readonly ttlMs: number) {}

  invalidate() {
    this.generation += 1;
    this.cached = null;
  }

  private syncConnection() {
    if (this.revision === connectionRevision) return;
    this.revision = connectionRevision;
    this.invalidate();
    this.pending = null;
    this.failure = null;
    this.failures = 0;
  }

  peek(): T | undefined {
    this.syncConnection();
    return this.cached?.value;
  }

  get(load: () => Promise<T>, force = false, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return waitForReader(this.read(load, force), signal);
  }

  private async read(load: () => Promise<T>, force: boolean): Promise<T> {
    this.syncConnection();
    assertReadAllowed();
    if (this.failure && Date.now() < this.failure.retryAt) throw this.failure;

    if (this.pending?.generation === this.generation) {
      // A trade event must get a snapshot taken after the event, even if a
      // passive read was already in progress. Concurrent event readers share
      // this follow-up request. Ordinary readers simply share the first read.
      if (force && !this.pending.force) {
        await this.pending.request;
        return this.read(load, true);
      }
      return this.pending.request;
    }
    if (!force && this.cached && Date.now() - this.cached.at < this.ttlMs) {
      return this.cached.value;
    }

    const generation = this.generation;
    const revision = this.revision;
    const request = Promise.resolve()
      .then(load)
      .then((value) => {
        if (revision !== connectionRevision) {
          throw new Error("The Binance connection changed. Refreshing account data.");
        }
        if (generation === this.generation) {
          this.cached = { value, at: Date.now() };
          this.failure = null;
          this.failures = 0;
        }
        return value;
      })
      .catch((error: unknown) => {
        if (generation === this.generation && revision === connectionRevision) {
          this.failures += 1;
          const retryAt = error instanceof SnapshotReadError ? error.retryAt : 0;
          this.failure = new SnapshotReadError(
            error instanceof Error ? error.message : "Terminal could not refresh Binance data.",
            Math.max(Date.now() + Math.min(4_000 * 2 ** (this.failures - 1), 60_000), retryAt),
          );
          if (/Binance API error -(2015|2014):/i.test(this.failure.message)) {
            accessFailure = this.failure;
          }
          throw this.failure;
        }
        throw error;
      })
      .finally(() => {
        if (this.pending?.request === request) this.pending = null;
      });
    this.pending = { request, force, generation };
    return request;
  }
}
