import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectSse, type SseClientOptions } from './sse-client.js';

/**
 * Test stub for react-native-sse. We don't import the real class —
 * `connectSse` accepts an `eventSourceCtor` injection seam so tests
 * can hand it this fake constructor. Each test inspects the
 * captured instances via the module-level `instances` array.
 *
 * The fake mirrors the surface area `connectSse` actually uses:
 *   - constructor(url, { headers, pollingInterval })
 *   - addEventListener(type, listener)
 *   - close()
 * and exposes `dispatch(type, payload)` so a test can simulate
 * server-driven events deterministically.
 */
interface FakeEventSourceLike {
  url: string;
  options: { headers?: Record<string, string>; pollingInterval?: number };
  closed: boolean;
  closeCount: number;
  listeners: Map<string, Array<(event: unknown) => void>>;
  addEventListener(type: string, cb: (event: unknown) => void): void;
  close(): void;
  dispatch(type: string, payload: unknown): void;
}

const instances: FakeEventSourceLike[] = [];

class FakeEventSource implements FakeEventSourceLike {
  url: string;
  options: { headers?: Record<string, string>; pollingInterval?: number };
  closed = false;
  closeCount = 0;
  listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(
    url: URL | string,
    options: { headers?: Record<string, string>; pollingInterval?: number } = {}
  ) {
    this.url = typeof url === 'string' ? url : url.toString();
    this.options = options;
    instances.push(this);
  }

  addEventListener(type: string, cb: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  close(): void {
    if (this.closed) {
      this.closeCount += 1;
      return;
    }
    this.closed = true;
    this.closeCount += 1;
  }

  dispatch(type: string, payload: unknown): void {
    const list = this.listeners.get(type) ?? [];
    for (const cb of list) cb(payload);
  }
}

afterEach(() => {
  instances.length = 0;
  vi.clearAllMocks();
});

const baseOptions = (
  overrides: Partial<SseClientOptions> = {}
): SseClientOptions => ({
  url: 'https://api/v1/tasks/abc/stream',
  authHeader: async () => 'Bearer initial-token',
  onMessage: vi.fn(),
  // The public `eventSourceCtor` accepts the real `react-native-sse`
  // type. Our fake's surface is structurally compatible with what
  // `connectSse` calls, so the cast is safe for the test seam.
  eventSourceCtor: FakeEventSource as unknown as SseClientOptions['eventSourceCtor'],
  ...overrides
});

// Helpers to flush the floating async work `connectSse` kicks off
// before the underlying EventSource is constructed.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

describe('connectSse — auth header injection', () => {
  it('attaches Authorization from authHeader() and Accept: text/event-stream', async () => {
    connectSse(baseOptions());
    await flush();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.options.headers).toEqual({
      Accept: 'text/event-stream',
      Authorization: 'Bearer initial-token'
    });
  });

  it('omits Authorization when authHeader returns undefined', async () => {
    connectSse(baseOptions({ authHeader: async () => undefined }));
    await flush();
    expect(instances[0]!.options.headers).toEqual({
      Accept: 'text/event-stream'
    });
  });

  it('attaches Last-Event-ID when the caller passes a resume seq', async () => {
    connectSse(baseOptions({ lastEventId: '42' }));
    await flush();
    expect(instances[0]!.options.headers!['Last-Event-ID']).toBe('42');
  });

  it('disables react-native-sse auto-reconnect (pollingInterval: 0)', async () => {
    connectSse(baseOptions());
    await flush();
    expect(instances[0]!.options.pollingInterval).toBe(0);
  });
});

describe('connectSse — message + close lifecycle', () => {
  it('forwards delta event payloads to the consumer with id from lastEventId', async () => {
    const onMessage = vi.fn();
    connectSse(baseOptions({ onMessage }));
    await flush();
    instances[0]!.dispatch('delta', {
      type: 'delta',
      data: '{"kind":"delta","delta":{"seq":1}}',
      lastEventId: '1',
      url: 'https://api/v1/tasks/abc/stream'
    });
    expect(onMessage).toHaveBeenCalledWith({
      id: '1',
      data: '{"kind":"delta","delta":{"seq":1}}'
    });
  });

  it('forwards status events too (not just delta)', async () => {
    const onMessage = vi.fn();
    connectSse(baseOptions({ onMessage }));
    await flush();
    instances[0]!.dispatch('status', {
      type: 'status',
      data: '{"kind":"status","status":"executing","seq":3}',
      lastEventId: '3',
      url: 'https://api/v1/tasks/abc/stream'
    });
    expect(onMessage).toHaveBeenCalledWith({
      id: '3',
      data: '{"kind":"status","status":"executing","seq":3}'
    });
  });

  it('omits id when lastEventId is null', async () => {
    const onMessage = vi.fn();
    connectSse(baseOptions({ onMessage }));
    await flush();
    instances[0]!.dispatch('delta', {
      type: 'delta',
      data: '{"kind":"delta","delta":{"seq":1}}',
      lastEventId: null,
      url: 'https://api/v1/tasks/abc/stream'
    });
    expect(onMessage).toHaveBeenCalledWith({
      data: '{"kind":"delta","delta":{"seq":1}}'
    });
  });

  it('fires onClose("server-end") + closes the socket on a `completed` frame', async () => {
    const onClose = vi.fn();
    connectSse(baseOptions({ onClose }));
    await flush();
    expect(instances[0]!.closed).toBe(false);
    instances[0]!.dispatch('completed', {
      type: 'completed',
      data: '{"kind":"completed","output":"hello","seq":4}',
      lastEventId: '4',
      url: 'https://api/v1/tasks/abc/stream'
    });
    expect(onClose).toHaveBeenCalledWith('server-end');
    expect(instances[0]!.closed).toBe(true);
  });

  it('fires onClose("server-end") on a `failed` frame too', async () => {
    const onClose = vi.fn();
    connectSse(baseOptions({ onClose }));
    await flush();
    instances[0]!.dispatch('failed', {
      type: 'failed',
      data: '{"kind":"failed","error":{"code":"x","message":"y"},"seq":4}',
      lastEventId: '4',
      url: 'https://api/v1/tasks/abc/stream'
    });
    expect(onClose).toHaveBeenCalledWith('server-end');
    expect(instances[0]!.closed).toBe(true);
  });

  it('fires onClose("aborted") on close() and is idempotent', async () => {
    const onClose = vi.fn();
    const conn = connectSse(baseOptions({ onClose }));
    await flush();
    conn.close();
    conn.close();
    expect(onClose).toHaveBeenCalledExactlyOnceWith('aborted');
    expect(instances[0]!.closed).toBe(true);
  });

  it('does not invoke onMessage after close()', async () => {
    const onMessage = vi.fn();
    const conn = connectSse(baseOptions({ onMessage }));
    await flush();
    conn.close();
    instances[0]!.dispatch('delta', {
      type: 'delta',
      data: '{"x":1}',
      lastEventId: '1',
      url: 'https://api/v1/tasks/abc/stream'
    });
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('connectSse — 401 mid-stream (NOTE 4)', () => {
  it('with onUnauthorized resolving true, fires onClose("reauth-needed") so the screen reconnects', async () => {
    const onUnauthorized = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    connectSse(baseOptions({ onUnauthorized, onClose }));
    await flush();
    instances[0]!.dispatch('error', {
      type: 'error',
      message: 'unauthorized',
      xhrStatus: 401,
      xhrState: 4
    });
    await flush();
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith('reauth-needed');
    expect(instances[0]!.closed).toBe(true);
  });

  it('with onUnauthorized resolving false, fires onClose("fatal")', async () => {
    const onUnauthorized = vi.fn().mockResolvedValue(false);
    const onClose = vi.fn();
    connectSse(baseOptions({ onUnauthorized, onClose }));
    await flush();
    instances[0]!.dispatch('error', {
      type: 'error',
      message: 'unauthorized',
      xhrStatus: 401,
      xhrState: 4
    });
    await flush();
    expect(onClose).toHaveBeenCalledWith('fatal');
  });

  it('with onUnauthorized throwing, fires onClose("fatal")', async () => {
    const onUnauthorized = vi.fn().mockRejectedValue(new Error('refresh boom'));
    const onClose = vi.fn();
    connectSse(baseOptions({ onUnauthorized, onClose }));
    await flush();
    instances[0]!.dispatch('error', {
      type: 'error',
      xhrStatus: 401,
      xhrState: 4
    });
    await flush();
    expect(onClose).toHaveBeenCalledWith('fatal');
  });

  it('without onUnauthorized, 401 is fatal', async () => {
    const onClose = vi.fn();
    connectSse(baseOptions({ onClose }));
    await flush();
    instances[0]!.dispatch('error', {
      type: 'error',
      xhrStatus: 401,
      xhrState: 4
    });
    await flush();
    expect(onClose).toHaveBeenCalledWith('fatal');
  });

  it('end-to-end NOTE 4: 401 mid-stream → refresh → reconnect with rotated Bearer + Last-Event-ID, no delta loss', async () => {
    // Simulates the exact screen-level reconnect choreography.
    const messages: Array<{ id?: string; data: string }> = [];
    let currentToken = 'Bearer t1';
    const onUnauthorized = vi.fn(async () => {
      currentToken = 'Bearer t2-rotated';
      return true;
    });

    const open = (lastEventId?: string): void => {
      connectSse(
        baseOptions({
          authHeader: async () => currentToken,
          lastEventId,
          onUnauthorized,
          onMessage: (m) => messages.push(m),
          onClose: (reason) => {
            if (reason === 'reauth-needed') {
              const lastSeq = messages[messages.length - 1]?.id;
              open(lastSeq);
            }
          }
        })
      );
    };

    open();
    await flush();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.options.headers!.Authorization).toBe('Bearer t1');

    // Server delivers seq=1 then seq=2 cleanly.
    instances[0]!.dispatch('delta', {
      type: 'delta',
      data: JSON.stringify({
        kind: 'delta',
        delta: { seq: 1, delta: 'hello ', timestamp: 'x' }
      }),
      lastEventId: '1',
      url: 'https://api/v1/tasks/abc/stream'
    });
    instances[0]!.dispatch('delta', {
      type: 'delta',
      data: JSON.stringify({
        kind: 'delta',
        delta: { seq: 2, delta: 'world', timestamp: 'x' }
      }),
      lastEventId: '2',
      url: 'https://api/v1/tasks/abc/stream'
    });

    // 401 mid-stream — react-native-sse surfaces this via the
    // 'error' channel with xhrStatus: 401.
    instances[0]!.dispatch('error', {
      type: 'error',
      xhrStatus: 401,
      xhrState: 4
    });
    await flush();

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(2);
    expect(instances[1]!.options.headers!.Authorization).toBe('Bearer t2-rotated');
    expect(instances[1]!.options.headers!['Last-Event-ID']).toBe('2');

    // Server resumes from seq=3 on the new connection — verify the
    // delta is delivered and added to the same messages array,
    // proving no delta was lost across the reauth.
    instances[1]!.dispatch('delta', {
      type: 'delta',
      data: JSON.stringify({
        kind: 'delta',
        delta: { seq: 3, delta: '!', timestamp: 'x' }
      }),
      lastEventId: '3',
      url: 'https://api/v1/tasks/abc/stream'
    });
    expect(messages.map((m) => m.id)).toEqual(['1', '2', '3']);
  });
});

describe('connectSse — non-401 errors', () => {
  it('forwards transport-level errors (xhrStatus:0) via onError but does not close', async () => {
    const onError = vi.fn();
    const onClose = vi.fn();
    connectSse(baseOptions({ onError, onClose }));
    await flush();
    instances[0]!.dispatch('error', {
      type: 'error',
      message: 'network blip',
      xhrStatus: 0,
      xhrState: 0
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fires onClose("fatal") on non-401 HTTP error (e.g. 500)', async () => {
    const onClose = vi.fn();
    connectSse(baseOptions({ onClose }));
    await flush();
    instances[0]!.dispatch('error', {
      type: 'error',
      message: 'server error',
      xhrStatus: 500,
      xhrState: 4
    });
    expect(onClose).toHaveBeenCalledWith('fatal');
    expect(instances[0]!.closed).toBe(true);
  });

  it('fires onClose("fatal") if authHeader() throws', async () => {
    const onClose = vi.fn();
    const onError = vi.fn();
    connectSse(
      baseOptions({
        authHeader: async () => {
          throw new Error('keychain locked');
        },
        onClose,
        onError
      })
    );
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith('fatal');
    // Constructor never invoked — no socket to close.
    expect(instances).toHaveLength(0);
  });
});
