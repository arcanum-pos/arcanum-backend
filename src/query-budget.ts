// D1 query budget per Worker invocation. On the Workers Free plan D1 allows
// only 50 queries per invocation, and every statement inside a batch()
// counts (developers.cloudflare.com/d1/platform/limits). Local runtimes don't
// enforce it, so without this a request that's fine in tests can fail in
// production.
//
// When the D1_QUERY_LIMIT var is set (the test suite sets it to 50 — see
// vitest.config.mts), env.DB is wrapped in a counter that throws once a
// request goes over it. Unset in production: no wrapper, no overhead.
import type { Env } from './env';

export class QueryBudgetExceeded extends Error {}

export function withQueryBudget(env: Env): Env {
  const limit = Number(env.D1_QUERY_LIMIT);
  if (!Number.isInteger(limit) || limit <= 0) return env;

  let used = 0;
  const spend = (n: number) => {
    used += n;
    if (used > limit) throw new QueryBudgetExceeded(`D1 query budget exceeded: ${used} queries in one invocation (limit ${limit}, the Workers Free plan's)`);
  };

  // Proxies around prepared statements must be unwrapped before batch(),
  // which only accepts the runtime's own statement objects.
  const unwrap = new WeakMap<object, D1PreparedStatement>();
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...args: unknown[]) => wrapStatement(target.bind(...args));
        if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
          return (...args: unknown[]) => {
            try {
              spend(1);
            } catch (err) {
              return Promise.reject(err);
            }
            return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    unwrap.set(proxy, statement);
    return proxy;
  };

  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrapStatement(target.prepare(sql));
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          try {
            spend(statements.length);
          } catch (err) {
            return Promise.reject(err);
          }
          return target.batch(statements.map((s) => unwrap.get(s) ?? s));
        };
      }
      if (prop === 'exec') {
        return (sql: string) => {
          spend(sql.split(';').filter((s) => s.trim()).length);
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...env, DB: db };
}
