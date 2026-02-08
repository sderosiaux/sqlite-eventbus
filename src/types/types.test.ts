import { describe, it, expect } from 'vitest';
import {
  type Event,
  type Subscription,
  type RetryPolicy,
  type EventStatus,
  type EventHandler,
  DEFAULT_RETRY_POLICY,
  EVENT_STATUSES,
} from './index.js';

describe('CHK-001: Shared types', () => {
  describe('EventStatus', () => {
    it('defines exactly four statuses: pending, processing, done, dlq', () => {
      expect(EVENT_STATUSES).toEqual(['pending', 'processing', 'done', 'dlq']);
    });
  });

  describe('DEFAULT_RETRY_POLICY', () => {
    it('has correct defaults per spec', () => {
      expect(DEFAULT_RETRY_POLICY).toEqual({
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
      });
    });
  });

  describe('Event interface shape', () => {
    it('constructs a valid Event object', () => {
      const event: Event = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'user.created',
        payload: { name: 'Alice' },
        createdAt: new Date(),
        status: 'pending',
        retryCount: 0,
      };
      expect(event.id).toBeDefined();
      expect(event.type).toBe('user.created');
      expect(event.status).toBe('pending');
      expect(event.retryCount).toBe(0);
    });

    it('supports optional metadata and lastError', () => {
      const event: Event = {
        id: '550e8400-e29b-41d4-a716-446655440001',
        type: 'order.shipped',
        payload: { orderId: 42 },
        createdAt: new Date(),
        status: 'dlq',
        retryCount: 3,
        lastError: 'Timeout exceeded',
        metadata: { source: 'api', traceId: 'abc-123' },
      };
      expect(event.lastError).toBe('Timeout exceeded');
      expect(event.metadata).toEqual({ source: 'api', traceId: 'abc-123' });
    });
  });

  describe('Subscription interface shape', () => {
    it('constructs a valid Subscription object', () => {
      const handler: EventHandler = async (_event: Event) => {};
      const sub: Subscription = {
        id: '660e8400-e29b-41d4-a716-446655440000',
        eventType: 'user.*',
        handler,
        createdAt: new Date(),
      };
      expect(sub.eventType).toBe('user.*');
      expect(typeof sub.handler).toBe('function');
    });
  });

  describe('RetryPolicy interface shape', () => {
    it('constructs a valid RetryPolicy', () => {
      const policy: RetryPolicy = {
        maxRetries: 5,
        baseDelayMs: 500,
        maxDelayMs: 10000,
        backoffMultiplier: 3,
      };
      expect(policy.maxRetries).toBe(5);
      expect(policy.backoffMultiplier).toBe(3);
    });
  });
});
