import { Result } from 'better-result';
import type { ZodType } from 'zod';

import { SourceError, sourceError } from './source-error';
import type { DownloadProgressHandler, FetchRequest, SourceResult } from './source-types';

interface SourceRequestOptions {
  source: 'beatleader' | 'beatsaver' | 'local' | 'scoresaber';
  label: string;
  operation: string;
  onProgress?: DownloadProgressHandler;
  request?: FetchRequest;
  signal?: AbortSignal;
  /** The browser's HTTP cache mode for this request (fetch's `cache` option). */
  httpCache?: RequestCache;
}

// Time limits for talking to BeatSaver & co. Without them a request on a bad connection could hang
// for minutes (the browser's own timeout) while the wallpaper sat on "loading".
/** An API request (JSON) — response and body together. */
const REQUEST_TIMEOUT_MS = 8000;
/** A download: waiting for the response to start, or for the next piece of data once it has. */
const DOWNLOAD_STALL_MS = 8000;
/** A download that has been running for DOWNLOAD_SPEED_GRACE_MS but still averages less than this
 *  is given up on: the connection is there, just too slow to be worth waiting for (a 10 MB map at
 *  100 KB/s would take almost two minutes). */
const DOWNLOAD_MIN_BYTES_PER_SECOND = 100 * 1024;
const DOWNLOAD_SPEED_GRACE_MS = 5000;

/** An AbortController that also follows the caller's signal, plus a restartable deadline. */
function deadline(outer: AbortSignal | undefined) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reason: string | null = null;
  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    signal: controller.signal,
    /** (Re)starts the deadline: abort with `why` unless extend()/done() comes first. */
    extend(ms: number, why: string) {
      clear();
      timer = setTimeout(() => {
        reason = why;
        controller.abort(new Error(why));
      }, ms);
    },
    abort(why: string) {
      clear();
      reason = why;
      controller.abort(new Error(why));
    },
    done() {
      clear();
      outer?.removeEventListener('abort', onOuterAbort);
    },
    /** Why we aborted it ourselves (timed out, too slow), or null. */
    get reason() {
      return reason;
    },
  };
}

type Deadline = ReturnType<typeof deadline>;

async function responseArrayBuffer(response: Response, timer: Deadline, onProgress?: DownloadProgressHandler) {
  if (response.body === null) {
    const data = await response.arrayBuffer();
    onProgress?.(1);
    return data;
  }
  const contentLength = Number(response.headers.get('content-length'));
  const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
  onProgress?.(total === null ? null : 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const startedAt = performance.now();
  let loaded = 0;
  timer.extend(DOWNLOAD_STALL_MS, 'stalled');
  let chunk = await reader.read();
  while (!chunk.done) {
    chunks.push(chunk.value);
    loaded += chunk.value.byteLength;
    onProgress?.(total === null ? null : Math.min(loaded / total, 1));
    const elapsed = performance.now() - startedAt;
    const remaining = total === null ? Infinity : total - loaded;
    // Too slow on average (and not about to finish anyway): give up rather than crawl on.
    if (
      elapsed > DOWNLOAD_SPEED_GRACE_MS &&
      remaining > DOWNLOAD_MIN_BYTES_PER_SECOND &&
      (loaded * 1000) / elapsed < DOWNLOAD_MIN_BYTES_PER_SECOND
    ) {
      timer.abort('too slow');
      throw new Error('download too slow');
    }
    timer.extend(DOWNLOAD_STALL_MS, 'stalled');
    chunk = await reader.read();
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress?.(1);
  return bytes.buffer;
}

async function sourceResponse(
  url: string,
  options: SourceRequestOptions,
  timer: Deadline,
  timeoutMs: number,
): Promise<SourceResult<Response>> {
  timer.extend(timeoutMs, 'timed out');
  const result = await Result.tryPromise({
    try: () =>
      (options.request ?? fetch)(url, {
        signal: timer.signal,
        ...(options.httpCache === undefined ? {} : { cache: options.httpCache }),
      }),
    catch: (cause) => {
      return sourceError(cause, {
        message:
          timer.reason === null ? `${options.label} request failed` : `${options.label} request ${timer.reason}`,
        source: options.source,
        operation: options.operation,
      });
    },
  });
  if (result.isErr()) return result;
  if (result.value.ok) return result;
  return Result.err(
    new SourceError({
      message:
        result.value.status === 404
          ? `${options.label} was not found`
          : `${options.label} failed (${String(result.value.status)})`,
      source: options.source,
      operation: options.operation,
      status: result.value.status,
    }),
  );
}

export async function requestJson<T>(
  url: string,
  schema: ZodType<T>,
  options: SourceRequestOptions,
): Promise<SourceResult<T>> {
  const timer = deadline(options.signal);
  try {
    return await Result.gen(async function* () {
      const response = yield* Result.await(sourceResponse(url, options, timer, REQUEST_TIMEOUT_MS));
      const parsed = yield* Result.await(
        Result.tryPromise({
          try: async () => schema.safeParse(await response.json()),
          catch: (cause) => {
            return sourceError(cause, {
              message:
                timer.reason === null
                  ? `${options.label} returned invalid JSON`
                  : `${options.label} response ${timer.reason}`,
              source: options.source,
              operation: options.operation,
            });
          },
        }),
      );
      return parsed.success
        ? Result.ok(parsed.data)
        : Result.err(
            new SourceError({
              message: `${options.label} returned unexpected data`,
              source: options.source,
              operation: options.operation,
              cause: parsed.error,
            }),
          );
    });
  } finally {
    timer.done();
  }
}

export async function requestArrayBuffer(
  url: string,
  options: SourceRequestOptions,
): Promise<SourceResult<ArrayBuffer>> {
  const timer = deadline(options.signal);
  try {
    return await Result.gen(async function* () {
      const response = yield* Result.await(sourceResponse(url, options, timer, DOWNLOAD_STALL_MS));
      const data = yield* Result.await(
        Result.tryPromise({
          try: () => responseArrayBuffer(response, timer, options.onProgress),
          catch: (cause) => {
                  return sourceError(cause, {
              message:
                timer.reason === null
                  ? `${options.label} could not be read`
                  : `${options.label} download ${timer.reason}`,
              source: options.source,
              operation: options.operation,
            });
          },
        }),
      );
      return Result.ok(data);
    });
  } finally {
    timer.done();
  }
}
