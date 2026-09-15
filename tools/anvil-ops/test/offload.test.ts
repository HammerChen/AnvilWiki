import { describe, expect, it, vi } from 'vitest';
import { canOffload, OFFLOAD_TIMEOUT_MS, WatchdogTimeout, withWatchdog } from '../src/mcp/offload.js';

describe('offload watchdog', () => {
  it('passes the task result through when it wins the race', async () => {
    const onTimeout = vi.fn();
    await expect(withWatchdog(Promise.resolve('done'), 5_000, onTimeout)).resolves.toBe('done');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('propagates task rejection untouched (not a WatchdogTimeout)', async () => {
    await expect(withWatchdog(Promise.reject(new Error('boom')), 5_000, () => {})).rejects.toThrow('boom');
  });

  it('fires onTimeout and rejects with WatchdogTimeout when the task never settles', async () => {
    const onTimeout = vi.fn();
    await expect(withWatchdog(new Promise(() => {}), 5, onTimeout)).rejects.toBeInstanceOf(WatchdogTimeout);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('watchdog budget is the documented 10-minute constant', () => {
    // Deliberately tighter than the inner 15min-per-step spawn budget: a hung
    // worker must fail loudly instead of holding the stdio loop's promise.
    expect(OFFLOAD_TIMEOUT_MS).toBe(10 * 60_000);
  });

  it('canOffload is false under vitest (source form, no dist worker) — the known constraint keeping offload itself integration-untested', () => {
    expect(canOffload()).toBe(false);
  });
});
