import EventSource from 'react-native-sse';

/**
 * Minimal wrapper over `react-native-sse` tuned for our SSE
 * contract. The wrapper exists because the platform-shaped
 * `EventSource` (the W3C standard) does not let the caller attach
 * an `Authorization` header and our server emits multiple event
 * types (`delta` / `status` / `completed` / `failed` / `heartbeat`)
 * that we want bridged into a single message stream for the screen.
 *
 * Migrated from `@microsoft/fetch-event-source` in Phase 3.4.1
 * because that library calls `Response.body.getReader()` internally,
 * and React Native's built-in `fetch` does not expose `Response.body`
 * as a `ReadableStream` — the first SSE delta crashed the streaming
 * screen with `Cannot read property 'getReader' of undefined`.
 * `react-native-sse` is XHR-based and works correctly under Hermes.
 *
 * Wrapper behaviour:
 *
 *   - Bearer auth header injected via a callback so each (re)connect
 *     reads the *current* access token (rotation-safe).
 *   - 401 mid-stream invokes `onUnauthorized()`. The wrapper does
 *     NOT retry intra-call after a refresh: react-native-sse holds
 *     onto the headers it was constructed with, so a self-retry
 *     would re-send the *old* bearer. Instead, on a successful
 *     refresh the wrapper closes with reason `'reauth-needed'` so
 *     the *caller* (the screen) can call `connectSse()` again and
 *     pick up the rotated bearer via `authHeader()`. NOTE 4 —
 *     mandatory mid-stream auth-rotation path.
 *   - `lastEventId` is surfaced as the `Last-Event-ID` request
 *     header so reconnects after `'reauth-needed'` or `'fatal'`
 *     resume from `seq + 1` and the server skips the replay of
 *     deltas the client has already rendered.
 *   - The library's built-in auto-reconnect is disabled
 *     (`pollingInterval: 0`). The screen owns reconnect strategy.
 *
 * Caller treats the returned `close()` as idempotent. Calling it
 * after the server has already ended the stream is a silent no-op.
 */
export interface SseEventMessage {
  /** Event id from the server (`id:` field), if present. */
  readonly id?: string;
  /** Raw `data:` payload from the SSE frame. */
  readonly data: string;
}

export interface SseClientOptions {
  readonly url: string;
  /**
   * Returns the Authorization header value (e.g. `Bearer eyJ…`) to
   * attach to this connect, or `undefined` to send no auth.
   * Called once per `connectSse()` invocation — token rotation
   * requires the caller to re-invoke `connectSse()` after a
   * `'reauth-needed'` close.
   */
  authHeader(): Promise<string | undefined>;
  /** Called for each non-heartbeat SSE frame. */
  onMessage(message: SseEventMessage): void;
  /**
   * Called when the server returns 401. Implementations should try
   * to refresh tokens and resolve `true` if a fresh `connectSse()`
   * call would now succeed. Resolving `false` (or throwing) closes
   * the stream with reason `'fatal'`.
   *
   * If omitted, 401 is treated as fatal.
   */
  onUnauthorized?(): Promise<boolean>;
  /**
   * Called when the connection ends. Idempotent: at most one
   * invocation per `connectSse()` call.
   *
   *   - `'server-end'`     server closed cleanly (terminal frame seen)
   *   - `'reauth-needed'`  401 + onUnauthorized resolved true; the
   *                        caller should re-invoke `connectSse()`
   *                        with the rotated bearer
   *   - `'fatal'`          unrecoverable error or 401 with refusal
   *                        to refresh
   *   - `'aborted'`        caller invoked `close()`
   */
  onClose?(reason: 'server-end' | 'reauth-needed' | 'fatal' | 'aborted'): void;
  /**
   * Called for non-401 fetch / network errors. The underlying
   * client will reconnect with backoff after this fires (unless
   * the implementation throws to abort).
   */
  onError?(error: unknown): void;
  /**
   * Resume token from a previous connection. Sent as the
   * `Last-Event-ID` request header so the server skips deltas
   * already delivered. Pass `undefined` for first connect.
   */
  lastEventId?: string;
  /**
   * Override the EventSource constructor. Tests inject a fake
   * class that lets them drive open/message/error/close events
   * synchronously. Defaults to `react-native-sse`'s `EventSource`.
   */
  eventSourceCtor?: typeof EventSource;
}

export interface SseConnection {
  /** Idempotent. Tears down the stream and fires onClose('aborted'). */
  close(): void;
}

type CloseReason = 'server-end' | 'reauth-needed' | 'fatal' | 'aborted';

/**
 * Server-side event names emitted by `apps/api/src/routes/tasks.ts`'s
 * SSE endpoint. The api always sets the `event:` line on each frame,
 * so listening to plain `'message'` would miss everything; we
 * register listeners for each kind and bridge them into the single
 * `onMessage` consumer callback.
 */
const SERVER_EVENT_TYPES = [
  'delta',
  'status',
  'completed',
  'failed',
  'heartbeat'
] as const;

type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];

const TERMINAL_EVENT_TYPES: ReadonlySet<ServerEventType> = new Set([
  'completed',
  'failed'
]);

/**
 * Connect to an SSE endpoint. Returns synchronously with a handle
 * for cancellation; the actual network connect happens on a
 * floating async task. Errors are surfaced via callbacks, never
 * thrown back to the caller.
 */
export const connectSse = (options: SseClientOptions): SseConnection => {
  let closed = false;
  let socket: EventSource<ServerEventType> | undefined;

  const fireClose = (reason: CloseReason): void => {
    if (closed) return;
    closed = true;
    try {
      options.onClose?.(reason);
    } catch {
      /* swallow — caller errors must not crash the stream */
    }
  };

  const closeSocket = (): void => {
    if (socket !== undefined) {
      try {
        socket.close();
      } catch {
        /* swallow */
      }
      socket = undefined;
    }
  };

  void runConnect(options, {
    isClosed: () => closed,
    setSocket: (es) => {
      if (closed) {
        try {
          es.close();
        } catch {
          /* swallow */
        }
        return;
      }
      socket = es;
    },
    closeSocket,
    fireClose
  });

  return {
    close() {
      if (closed) return;
      closeSocket();
      fireClose('aborted');
    }
  };
};

interface RunConnectHooks {
  readonly isClosed: () => boolean;
  readonly setSocket: (es: EventSource<ServerEventType>) => void;
  readonly closeSocket: () => void;
  readonly fireClose: (reason: CloseReason) => void;
}

const runConnect = async (
  options: SseClientOptions,
  hooks: RunConnectHooks
): Promise<void> => {
  let headers: Record<string, string>;
  try {
    headers = await buildHeaders(options);
  } catch (err) {
    options.onError?.(err);
    hooks.fireClose('fatal');
    return;
  }

  if (hooks.isClosed()) return;

  const Ctor = options.eventSourceCtor ?? EventSource;
  let es: EventSource<ServerEventType>;
  try {
    es = new Ctor<ServerEventType>(options.url, {
      headers,
      // Disable react-native-sse's built-in reconnect. The
      // streaming screen owns its own reconnect choreography
      // (NOTE 4 + Cloud Run pre-emptive hangup), and the
      // library's polling would otherwise re-open with stale
      // headers after a 401 + reauth.
      pollingInterval: 0
    });
  } catch (err) {
    options.onError?.(err);
    hooks.fireClose('fatal');
    return;
  }

  hooks.setSocket(es);

  for (const type of SERVER_EVENT_TYPES) {
    es.addEventListener(type, (event) => {
      if (hooks.isClosed()) return;
      const data = event.data ?? '';
      try {
        const message: SseEventMessage =
          event.lastEventId !== null && event.lastEventId !== undefined
            ? { id: event.lastEventId, data }
            : { data };
        options.onMessage(message);
      } catch (err) {
        options.onError?.(err);
        hooks.closeSocket();
        hooks.fireClose('fatal');
        return;
      }
      if (TERMINAL_EVENT_TYPES.has(type)) {
        hooks.closeSocket();
        hooks.fireClose('server-end');
      }
    });
  }

  es.addEventListener('error', (event) => {
    if (hooks.isClosed()) return;
    const xhrStatus =
      typeof (event as { xhrStatus?: unknown }).xhrStatus === 'number'
        ? ((event as { xhrStatus: number }).xhrStatus)
        : 0;

    if (xhrStatus === 401) {
      void handleUnauthorized(options, hooks);
      return;
    }

    if (xhrStatus >= 400) {
      // Hard HTTP failure that isn't 401 — fatal, no reconnect.
      hooks.closeSocket();
      hooks.fireClose('fatal');
      return;
    }

    // xhrStatus === 0 covers transport-level errors (timeout,
    // socket closed, exception). Surface to the consumer; the
    // screen decides whether to reconnect.
    options.onError?.(event);
  });
};

const handleUnauthorized = async (
  options: SseClientOptions,
  hooks: RunConnectHooks
): Promise<void> => {
  if (hooks.isClosed()) return;
  let refreshed = false;
  if (options.onUnauthorized) {
    try {
      refreshed = await options.onUnauthorized();
    } catch {
      refreshed = false;
    }
  }
  if (hooks.isClosed()) return;
  hooks.closeSocket();
  hooks.fireClose(refreshed ? 'reauth-needed' : 'fatal');
};

const buildHeaders = async (
  options: SseClientOptions
): Promise<Record<string, string>> => {
  const auth = await options.authHeader();
  // react-native-sse sets `Accept: text/event-stream` and
  // `Cache-Control: no-cache` itself; we only contribute auth +
  // resume-id, with `Accept` kept for parity with the previous
  // wrapper (the library is fine with the duplicate set).
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (auth !== undefined) headers.Authorization = auth;
  if (options.lastEventId !== undefined) {
    headers['Last-Event-ID'] = options.lastEventId;
  }
  return headers;
};
