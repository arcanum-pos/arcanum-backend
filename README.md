# arcanum-backend


Cloudflare Worker handling payments (Bancontact, SumUp, cash), tabs, catalogs and reports for Arcanum.

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

## Database migrations

Tracked by wrangler in the `d1_migrations` table (`migrations_dir` in
wrangler.jsonc):

```sh
npx wrangler d1 migrations apply arcanum-backend --remote   # before pushing code that needs it
npx wrangler d1 migrations list arcanum-backend --remote    # should say "No migrations to apply"
```

A new migration is three things in one commit: `migrations/NNNN_name.sql`,
the same change in `schema.sql` (a fresh install is built from it), and its
`INSERT OR IGNORE INTO d1_migrations` line at the end of `schema.sql`.
`test/installation.test.ts` fails if either is forgotten. Migrations are
forward-only and must work with the previous code version (they run before
the new code is deployed). The "Run once via: wrangler d1 execute …" notes in
migrations 0001–0017 predate this; all of those are marked as applied.

## License

Copyright (C) 2026 kaboutersoft.be

Arcanum is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. It is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

In short: free to use, self-host, modify, host for others and charge for
hosting or support — but if you run a modified version for users over a
network, you must offer those users its source code (AGPL §13). The app's
"Broncode" link (the `SOURCE_URL` setting of arcanum-bff) is how an
installation points its users to that source.
