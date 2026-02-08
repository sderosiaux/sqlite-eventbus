/**
 * Shared types for the EventBus system.
 */

export type EventStatus = 'pending' | 'processing' | 'done' | 'dlq';

export const EVENT_STATUSES: EventStatus[] = ['pending', 'processing', 'done', 'dlq'];

export interface Event {
  id: string;
  type: string;
  payload: unknown;
  createdAt: Date;
  status: EventStatus;
  retryCount: number;
  lastError?: string;
  metadata?: Record<string, string>;
}

export type EventHandler = (event: Event) => Promise<void>;

export interface SubscribeOptions {
  timeoutMs?: number;
}

export interface Subscription {
  id: string;
  eventType: string;
  handler: EventHandler;
  createdAt: Date;
  timeoutMs?: number;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/** Stored subscription row (no handler — handler lives in memory only). */
export interface SubscriptionRow {
  id: string;
  eventType: string;
  createdAt: Date;
}
