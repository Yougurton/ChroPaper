import type { EnvironmentWorkerResponse } from './environment-worker-protocol';
import type { EnvironmentData } from './types';

export function loadEnvironmentData(id: string, signal?: AbortSignal) {
  const worker = new Worker(new URL('./environment-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<EnvironmentData>((resolve, reject) => {
    function dispose() {
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    }

    function abort() {
      dispose();
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('environment load was cancelled', 'AbortError'),
      );
    }

    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<EnvironmentWorkerResponse>) => {
      dispose();
      if (event.data.ok) resolve(event.data.data);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      dispose();
      reject(new Error(event.message || 'environment worker failed'));
    };
    worker.onmessageerror = () => {
      dispose();
      reject(new Error('environment worker returned unreadable data'));
    };
    worker.postMessage({
      id,
      // Deliberately resolved to an *absolute* URL here, on the main thread, rather than handing
      // the worker the bare relative string (`${BASE_URL}environments/${id}.json`) and letting it
      // resolve that itself. A relative URL passed to fetch() inside a worker resolves against the
      // worker's *own* script location, not the page's — and after `vite build`, this worker gets
      // bundled into its own chunk under dist/assets/ while index.html stays at the dist root, so
      // that relative resolution silently landed on dist/assets/environments/... instead of
      // dist/environments/... (the actual public/environments copy). Only showed up post-build:
      // the dev server serves everything through the same virtual root, so both resolutions agreed
      // by coincidence there. Resolving against document.baseURI here, before the URL ever crosses
      // into the worker, makes it unambiguous regardless of where bundling puts the worker chunk.
      url: new URL(`${import.meta.env.BASE_URL}environments/${id}.json`, document.baseURI).href,
    });
  });
}
