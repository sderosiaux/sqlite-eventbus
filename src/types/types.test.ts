import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  type Event,
  type EventStatus,
  type Subscription,
  type SubscriptionRow,
  type SubscribeOptions,
  type RetryPolicy,
  type EventHandler,
} from './index.js';

describe('Shared Types', () => {
  it('EventStatus has exactly 4 values', () => {
    const statuses: EventStatus[] = ['pending', 'processing', 'done', 'dlq'];
    expect(statuses).toHaveLength(4);
  });

  it('Event interface has all required fields', () => {
    const event: Event = {
      id: '123',
      type: 'user.created',
      payload: { name: 'Alice' },
      createdAt: new Date(),
      status: 'pending',
      retryCount: 0,
    };
    expect(event.id).toBe('123');
    expect(event.type).toBe('user.created');
    expect(event.status).toBe('pending');
    expect(event.retryCount).toBe(0);
    expect(event.lastError).toBeUndefined();
    expect(event.metadata).toBeUndefined();
  });

  it('Event supports optional dlqAt timestamp (CHK-015)', () => {
    const now = new Date();
    const event: Event = {
      id: '123',
      type: 'test',
      payload: {},
      createdAt: now,
      status: 'dlq',
      retryCount: 3,
      dlqAt: now,
    };
    expect(event.dlqAt).toEqual(now);
  });

  it('Event supports optional metadata', () => {
    const event: Event = {
      id: '123',
      type: 'test',
      payload: {},
      createdAt: new Date(),
      status: 'pending',
      retryCount: 0,
      metadata: { source: 'api', traceId: 'abc' },
    };
    expect(event.metadata).toEqual({ source: 'api', traceId: 'abc' });
  });

  it('Event lastError stores JSON array of error strings', () => {
    const errors = ['Error 1', 'Error 2', 'Error 3'];
    const event: Event = {
      id: '123',
      type: 'test',
      payload: {},
      createdAt: new Date(),
      status: 'dlq',
      retryCount: 3,
      lastError: JSON.stringify(errors),
    };
    expect(JSON.parse(event.lastError!)).toEqual(errors);
  });

  it('Subscription includes handler and optional timeoutMs', () => {
    const handler: EventHandler = async () => {};
    const sub: Subscription = {
      id: 'sub-1',
      eventType: 'user.*',
      handler,
      createdAt: new Date(),
      timeoutMs: 5000,
    };
    expect(sub.handler).toBe(handler);
    expect(sub.timeoutMs).toBe(5000);
  });

  it('SubscriptionRow excludes handler (DB-safe)', () => {
    const row: SubscriptionRow = {
      id: 'sub-1',
      eventType: 'user.*',
      createdAt: new Date(),
    };
    expect(row).not.toHaveProperty('handler');
  });

  it('SubscribeOptions supports timeoutMs and retry override', () => {
    const opts: SubscribeOptions = {
      timeoutMs: 10000,
      retry: { maxRetries: 5, baseDelayMs: 500 },
    };
    expect(opts.timeoutMs).toBe(10000);
    expect(opts.retry?.maxRetries).toBe(5);
  });

  it('DEFAULT_RETRY_POLICY matches spec defaults', () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
    });
  });

  it('RetryPolicy partial override merges with defaults', () => {
    const override: Partial<RetryPolicy> = { maxRetries: 5, baseDelayMs: 500 };
    const merged: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...override };
    expect(merged).toEqual({
      maxRetries: 5,
      baseDelayMs: 500,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
    });
  });
});
