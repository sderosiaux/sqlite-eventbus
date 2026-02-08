// Shared types for the EventBus system

export type EventStatus = 'pending' | 'processing' | 'done' | 'dlq';

export interface Event {
  id: string;
  type: string;
  payload: unknown;
  createdAt: Date;
  status: EventStatus;
  retryCount: number;
  lastError?: string;       // JSON array of error strings from each failed attempt
  metadata?: Record<string, string>;
  dlqAt?: Date;             // Timestamp when event entered DLQ (CHK-015)
}

export type EventHandler = (event: Event) => Promise<void>;

// In-memory representation (with handler)
export interface Subscription {
  id: string;
  eventType: string;        // glob pattern: "user.*" matches "user.created"
  handler: EventHandler;
  createdAt: Date;
  timeoutMs?: number;       // per-subscription handler timeout override
  retry?: Partial<RetryPolicy>; // per-subscription retry override
}

// DB representation (handler is not serializable)
export interface SubscriptionRow {
  id: string;
  eventType: string;
  createdAt: Date;
}

export interface SubscribeOptions {
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
}

export interface RetryPolicy {
  maxRetries: number;       // default: 3
  baseDelayMs: number;      // default: 1000
  maxDelayMs: number;       // default: 30000
  backoffMultiplier: number; // default: 2
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};
