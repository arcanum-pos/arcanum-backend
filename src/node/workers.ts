// `cloudflare:workers`, the part the backend uses, for running self-hosted
// (SELF_HOSTING.md): esbuild (build:node) and the Node tests resolve
// `cloudflare:workers` to this file. `waitUntil`: on Cloudflare it keeps the
// Worker alive until the work is done; a Node process lives on anyway, so
// the work just runs — an error is logged, never left unhandled.
export function waitUntil(promise: Promise<unknown>): void {
  promise.catch((err) => console.error('waitUntil', err));
}
