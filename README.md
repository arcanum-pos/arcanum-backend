# arcanum-backend


Cloudflare Worker handling Bancontact payments and bon-price settings for Arcanum.

## Tests

```sh
npm test            # run once (what the deploy gate runs)
npm run test:watch  # re-run on change
npm run typecheck   # src + tests
```

Vitest with `@cloudflare/vitest-pool-workers`: tests run inside the real
Workers runtime (workerd) against a local D1 built from `schema.sql`
(applied in `test/setup.ts` — a schema change flows into the tests
automatically). Each test seeds its own random org (`test/helpers.ts`), so
tests never depend on each other or on a clean database.

Nothing leaves the machine:

- **Bancontact / SumUp HTTP** — stubbed per test with
  `vi.spyOn(globalThis, 'fetch')` (see `test/bancontact.test.ts`); any
  unexpected outbound call throws.
- **arcanum-devicehub / arcanum-mailer service bindings** — replaced in
  `vitest.config.mts` by stubs that record every call
  (`recordedCalls()` in the helpers).
- **Secrets** — fixed test values in `vitest.config.mts`, overriding
  anything in a local `.dev.vars` (a test guards this).
- **Bancontact's signed callback** isn't faked; charge resolution is tested
  through `/sumup/confirm` (the same `resolveCharge` path).

`package.json` overrides `miniflare` so the test pool runs the same workerd
as `wrangler` — the pool's own bundled one can lag behind this Worker's
`compatibility_date`. Revisit when bumping wrangler.

**Rule: every change ships with its tests in the same commit.** Money, tab
state and receipt-number rules are written test-first.
