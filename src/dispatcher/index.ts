import type { Event, Subscription } from '../types/index.js';
import type { SQLiteStore } from '../store/index.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface DispatcherOptions {
  defaultTimeoutMs?: number;
}

export class Dispatcher {
  private store: SQLiteStore;
  private handlers: Map<string, Subscription>;
  private defaultTimeoutMs: number;

  constructor(store: SQLiteStore, handlers: Map<string, Subscription>, opts?: DispatcherOptions) {
    this.store = store;
    this.handlers = handlers;
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async dispatch(event: Event): Promise<void> {
    const matching = this.findMatchingSubscriptions(event.type);

    if (matching.length === 0) {
      this.store.updateEventStatus(event.id, 'done');
      return;
    }

    this.store.updateEventStatus(event.id, 'processing');

    let failed = false;
    let lastError = '';

    for (const sub of matching) {
      const timeoutMs = sub.timeoutMs ?? this.defaultTimeoutMs;
      try {
        await this.invokeWithTimeout(sub, event, timeoutMs);
      } catch (err) {
        failed = true;
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (failed) {
      this.store.updateEventRetry(event.id, event.retryCount + 1, lastError);
    } else {
      this.store.updateEventStatus(event.id, 'done');
    }
  }

  private findMatchingSubscriptions(eventType: string): Subscription[] {
    const result: Subscription[] = [];
    for (const sub of this.handlers.values()) {
      if (matchGlob(sub.eventType, eventType)) {
        result.push(sub);
      }
    }
    return result;
  }

  private invokeWithTimeout(sub: Subscription, event: Event, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Handler timeout after ${timeoutMs}ms (subscription ${sub.id})`));
      }, timeoutMs);

      sub.handler(event).then(
        () => { clearTimeout(timer); resolve(); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }
}

/**
 * Simple glob matcher for event type patterns.
 * - `*` as the entire pattern matches everything
 * - `*` as a segment matches exactly one segment (non-empty, no dots)
 * - Segments are separated by `.`
 */
function matchGlob(pattern: string, eventType: string): boolean {
  if (pattern === '*') return true;

  const patternParts = pattern.split('.');
  const typeParts = eventType.split('.');

  if (patternParts.length !== typeParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === '*') continue;
    if (patternParts[i] !== typeParts[i]) return false;
  }

  return true;
}
