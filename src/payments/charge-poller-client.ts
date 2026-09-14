// Split out from poller.ts so sumup.ts/bancontact.ts (which both call this
// right after dispatching a charge to a provider) don't create a circular
// import with poller.ts (which itself imports from both of them to poll
// each provider's status API).
import type { Env } from '../env';

function getPollerStub(env: Env): DurableObjectStub {
  const id = env.CHARGE_POLLER.idFromName('singleton');
  return env.CHARGE_POLLER.get(id);
}

// Called right after a charge is dispatched to a provider (SumUp checkout
// created, Bancontact payment created) so the fallback sweep is armed even
// if nothing else pokes it. A no-op if a poll is already scheduled.
export async function ensureChargePolling(env: Env): Promise<void> {
  const stub = getPollerStub(env);
  await stub.fetch('https://charge-poller/ensure-scheduled');
}
