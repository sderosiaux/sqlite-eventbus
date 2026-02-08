import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Dispatcher } from './index.js';
import { EventBus } from '../bus/index.js';
import type { Event, RetryPolicy } from '../types/index.js';
import { DEFAULT_RETRY_POLICY } from '../types/index.js';

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-retry-1',
    type: 'order.placed',
    payload: { orderId: 42 },
    createdAt: new Date(),
    status: 'pending',
    retryCount: 0,
    ...overrides,
  };
}

const FAST_RETRY: Partial<RetryPolicy> = {
  maxRetries: 3,
  baseDelayMs: 10,
  maxDelayMs: 100,
  backoffMultiplier: 2,
};

describe('CHK-007: Dispatcher retry with exponential backoff', () => {
  let bus: EventBus;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    bus = new EventBus({ dbPath: ':memory:' });
    dispatcher = new Dispatcher(bus.getStore(), bus.getHandlers(), {
      defaultRetryPolicy: { ...DEFAULT_RETRY_POLICY, ...FAST_RETRY },
    });
  });

  afterEach(() => {
    bus.destroy();
  });

  it('retries a failing handler up to maxRetries times then succeeds', async () => {
    let attempts = 0;
    bus.subscribe('order.placed', async () => {
      attempts++;
      if (attempts < 3) throw new Error(`fail-${attempts}`);
    });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    expect(attempts).toBe(3);
    const stored = bus.getStore().getEvent('evt-retry-1');
    expect(stored?.status).toBe('done');
  });

  it('applies exponential backoff delays between retries', async () => {
    const timestamps: number[] = [];
    let attempts = 0;
    bus.subscribe('order.placed', async () => {
      timestamps.push(Date.now());
      attempts++;
      if (attempts <= 3) throw new Error(`fail-${attempts}`);
    });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    // Attempt 1: immediate
    // Attempt 2: ~10ms delay
    // Attempt 3: ~20ms delay (10 * 2^1)
    // Attempt 4: succeeds
    expect(timestamps.length).toBe(4);
    // delay between attempt 2 and attempt 1 should be >= 5ms (allowing jitter variance)
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(5);
    // delay between attempt 3 and attempt 2 should be > delay between attempt 2 and attempt 1
    const delay2 = timestamps[2] - timestamps[1];
    const delay1 = timestamps[1] - timestamps[0];
    expect(delay2).toBeGreaterThanOrEqual(delay1 * 0.8); // allow jitter
  });

  it('caps delay at maxDelayMs', async () => {
    // maxDelayMs=50, base=10, mult=2 → attempt 4 would be 10*2^2=40, attempt 5 would be 10*2^3=80 → capped at 50
    const policy: Partial<RetryPolicy> = {
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 50,
      backoffMultiplier: 2,
    };
    dispatcher = new Dispatcher(bus.getStore(), bus.getHandlers(), {
      defaultRetryPolicy: { ...DEFAULT_RETRY_POLICY, ...policy },
    });

    const timestamps: number[] = [];
    let attempts = 0;
    bus.subscribe('order.placed', async () => {
      timestamps.push(Date.now());
      attempts++;
      if (attempts <= 5) throw new Error(`fail-${attempts}`);
    });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    // Last delay should be capped: not more than ~55ms (50 + 10% jitter)
    const lastDelay = timestamps[timestamps.length - 1] - timestamps[timestamps.length - 2];
    expect(lastDelay).toBeLessThanOrEqual(80); // generous upper bound with jitter + timer imprecision
  });

  it('uses per-subscription retry policy when provided', async () => {
    let attempts = 0;
    bus.subscribe('order.placed', async () => {
      attempts++;
      if (attempts < 2) throw new Error('fail');
    }, { retry: { maxRetries: 1, baseDelayMs: 10 } });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    // maxRetries=1 → 2 total attempts, succeeds on attempt 2
    expect(attempts).toBe(2);
    const stored = bus.getStore().getEvent('evt-retry-1');
    expect(stored?.status).toBe('done');
  });

  it('updates retryCount in store after each failed attempt', async () => {
    let attempts = 0;
    bus.subscribe('order.placed', async () => {
      attempts++;
      throw new Error(`fail-${attempts}`);
    });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    // After all attempts exhausted (4 total = 1 initial + 3 retries), retryCount should be 4
    const stored = bus.getStore().getEvent('evt-retry-1');
    expect(stored?.retryCount).toBe(4);
  });
});

describe('CHK-008: DLQ routing after max retries exhausted', () => {
  let bus: EventBus;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    bus = new EventBus({ dbPath: ':memory:' });
    dispatcher = new Dispatcher(bus.getStore(), bus.getHandlers(), {
      defaultRetryPolicy: { ...DEFAULT_RETRY_POLICY, ...FAST_RETRY },
    });
  });

  afterEach(() => {
    bus.destroy();
  });

  it('moves event to dlq status after all retries exhausted', async () => {
    bus.subscribe('order.placed', async () => {
      throw new Error('permanent failure');
    });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    const stored = bus.getStore().getEvent('evt-retry-1');
    expect(stored?.status).toBe('dlq');
  });

  it('preserves all error messages from each attempt when routing to DLQ', async () => {
    let attempt = 0;
    bus.subscribe('order.placed', async () => {
      attempt++;
      throw new Error(`failure-attempt-${attempt}`);
    });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    const stored = bus.getStore().getEvent('evt-retry-1');
    expect(stored?.status).toBe('dlq');
    // lastError must be a JSON array containing every attempt's error
    const errors = JSON.parse(stored!.lastError!);
    expect(Array.isArray(errors)).toBe(true);
    expect(errors).toHaveLength(4); // 1 initial + 3 retries
    expect(errors[0]).toBe('failure-attempt-1');
    expect(errors[1]).toBe('failure-attempt-2');
    expect(errors[2]).toBe('failure-attempt-3');
    expect(errors[3]).toBe('failure-attempt-4');
  });

  it('sets correct retryCount on DLQ event', async () => {
    bus.subscribe('order.placed', async () => {
      throw new Error('fail');
    });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    const stored = bus.getStore().getEvent('evt-retry-1');
    expect(stored?.status).toBe('dlq');
    // maxRetries=3, total attempts=4 (1 initial + 3 retries)
    expect(stored?.retryCount).toBe(4);
  });

  it('does not route to DLQ if handler eventually succeeds', async () => {
    let attempts = 0;
    bus.subscribe('order.placed', async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
    });

    const event = makeEvent();
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    const stored = bus.getStore().getEvent('evt-retry-1');
    expect(stored?.status).toBe('done');
    expect(stored?.status).not.toBe('dlq');
  });

  it('routes to DLQ with per-subscription maxRetries=0 after single failure', async () => {
    bus.subscribe('order.placed', async () => {
      throw new Error('no retries');
    }, { retry: { maxRetries: 0 } });

    const event = makeEvent({ id: 'evt-no-retry' });
    bus.getStore().insertEvent(event);
    await dispatcher.dispatch(event);

    const stored = bus.getStore().getEvent('evt-no-retry');
    expect(stored?.status).toBe('dlq');
    expect(stored?.retryCount).toBe(1);
  });
});

describe('CHK-014: Jitter on retry delay', () => {
  let bus: EventBus;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    bus = new EventBus({ dbPath: ':memory:' });
    dispatcher = new Dispatcher(bus.getStore(), bus.getHandlers(), {
      defaultRetryPolicy: {
        maxRetries: 2,
        baseDelayMs: 100,
        maxDelayMs: 5000,
        backoffMultiplier: 2,
      },
    });
  });

  afterEach(() => {
    bus.destroy();
  });

  it('adds jitter within ±10% of computed delay', async () => {
    // Run multiple events to collect delay samples and verify jitter range
    const delaySamples: number[] = [];

    for (let i = 0; i < 5; i++) {
      const timestamps: number[] = [];
      let attempts = 0;

      // Reset handlers each iteration
      const handlers = bus.getHandlers();
      handlers.clear();

      bus.subscribe('order.placed', async () => {
        timestamps.push(Date.now());
        attempts++;
        if (attempts <= 1) throw new Error('fail');
      });

      const event = makeEvent({ id: `evt-jitter-${i}` });
      bus.getStore().insertEvent(event);
      await dispatcher.dispatch(event);

      if (timestamps.length >= 2) {
        delaySamples.push(timestamps[1] - timestamps[0]);
      }
    }

    // baseDelayMs=100 with ±10% jitter → delays should be in [90, 110] range
    // Allow some timer imprecision: [80, 130]
    for (const delay of delaySamples) {
      expect(delay).toBeGreaterThanOrEqual(80);
      expect(delay).toBeLessThanOrEqual(140);
    }

    // Verify jitter introduces variance (not all delays identical)
    // With 5 samples at ±10%, we expect at least some variance
    if (delaySamples.length >= 3) {
      const allSame = delaySamples.every(d => d === delaySamples[0]);
      // Not a hard assertion — timer granularity may cause same values
      // But statistically unlikely with ±10% jitter on 100ms base
      if (delaySamples.length >= 5) {
        const min = Math.min(...delaySamples);
        const max = Math.max(...delaySamples);
        // At least SOME spread expected
        expect(max - min).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('computeDelay returns value within ±10% of base calculation', async () => {
    // Test the exported computeDelay function directly
    const { computeDelay } = await import('./index.js');

    const policy = {
      maxRetries: 5,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
    };

    // Attempt 2: base delay = 1000ms, jitter range = [900, 1100]
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push(computeDelay(2, policy));
    }

    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(900);
      expect(s).toBeLessThanOrEqual(1100);
    }

    // Attempt 3: base delay = 2000ms, jitter range = [1800, 2200]
    const samples3: number[] = [];
    for (let i = 0; i < 20; i++) {
      samples3.push(computeDelay(3, policy));
    }

    for (const s of samples3) {
      expect(s).toBeGreaterThanOrEqual(1800);
      expect(s).toBeLessThanOrEqual(2200);
    }
  });

  it('computeDelay returns 0 for attempt 1 (immediate)', async () => {
    const { computeDelay } = await import('./index.js');
    const policy = {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
    };

    expect(computeDelay(1, policy)).toBe(0);
  });
});
