// A service binding (`fetch` to another Worker) as plain HTTP to that
// Service in the cluster (SELF_HOSTING.md): the backend asks `https://devicehub/…`,
// this sends it to e.g. `http://devicehub:8080/…` — path, query, method,
// headers and body as they are.
export function httpFetcher(baseUrl: string) {
  const base = new URL(baseUrl);
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const target = new URL(url.pathname + url.search, base);
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      return fetch(target, {
        method: request.method,
        headers: request.headers,
        body: hasBody ? request.body : undefined,
        // A streamed body (Node's fetch needs it said).
        ...(hasBody ? { duplex: 'half' } : {}),
      } as RequestInit);
    },
  };
}
