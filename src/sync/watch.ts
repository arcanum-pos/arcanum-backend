// Offline sync, the cloud's watch (OFFLINE.md): a box sends at least a
// heartbeat every 5 minutes while it's on and online. When a backup has
// heard nothing for an hour, the org's admins get a mail once (again only
// after it was back). The box itself can't warn: it may be the thing that
// broke.
//
// A Durable Object with an alarm (SyncWatch), not a Cron Trigger: the
// installer can't set those up (yet), and it's on the Workers Free plan
// (SQLite-backed). The first backup wakes it (ensureSyncWatch); it goes
// back to sleep when there are no backups left.
import type { Env } from '../env';
import { sendOrgEmail } from '../organizations/mail';
import type { Locale } from '../organizations/locale';

export const SILENCE_MS = 60 * 60_000;
const CHECK_MS = 15 * 60_000;
// Orgs per run: two queries and a mail each, within 50 queries.
const PER_RUN = 10;

const COPY: Record<Locale, { subject: (org: string) => string; text: (org: string, since: string, url: string) => string }> = {
  nl: {
    subject: (org) => `Arcanum: de reservekopie van ${org} wordt niet meer bijgewerkt`,
    text: (org, since, url) =>
      `De lokale installatie van ${org} heeft sinds ${since} (UTC) niets meer naar de reservekopie gestuurd.\n\n` +
      `Staat het toestel uit, heeft het geen internet, of is het stuk? Zolang het werkt, wacht alles daar en gaat het vanzelf mee zodra het weer kan.\n\n` +
      `Is het toestel stuk, dan kan een beheerder de reservekopie in gebruik nemen: ${url}/console/settings/backup\n`,
  },
  fr: {
    subject: (org) => `Arcanum : la sauvegarde de ${org} n’est plus mise à jour`,
    text: (org, since, url) =>
      `L’installation locale de ${org} n’a plus rien envoyé à la sauvegarde depuis ${since} (UTC).\n\n` +
      `L’appareil est-il éteint, sans internet, ou en panne ? Tant qu’il fonctionne, tout y attend et partira dès que possible.\n\n` +
      `Si l’appareil est en panne, un administrateur peut mettre la sauvegarde en service : ${url}/console/settings/backup\n`,
  },
  en: {
    subject: (org) => `Arcanum: the backup of ${org} is no longer being updated`,
    text: (org, since, url) =>
      `The local installation of ${org} has sent nothing to the backup since ${since} (UTC).\n\n` +
      `Is the device switched off, without internet, or broken? As long as it works, everything waits there and goes along as soon as it can.\n\n` +
      `If the device is broken, an administrator can take the backup into use: ${url}/console/settings/backup\n`,
  },
};

interface Silent {
  org_id: string;
  name: string;
  locale: Locale;
  since: string;
}

// The backups silent for over an hour and not warned about yet: their
// admins get the mail, then the link is marked. Returns how many backups
// there are at all (to keep watching or not).
export async function checkBackups(env: Env, now = Date.now()): Promise<{ warned: string[]; backups: number }> {
  const cutoff = new Date(now - SILENCE_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT l.org_id, o.name, o.locale, COALESCE(l.last_sync_at, l.created_at) AS since FROM sync_links l JOIN organizations o ON o.id = l.org_id
     WHERE l.role = 'replica' AND l.warned_at IS NULL AND COALESCE(l.last_sync_at, l.created_at) < ? LIMIT ?`
  )
    .bind(cutoff, PER_RUN)
    .all<Silent>();
  const warned: string[] = [];
  for (const backup of results ?? []) {
    const { results: admins } = await env.DB.prepare("SELECT invited_email FROM memberships WHERE org_id = ? AND role = 'admin' AND status = 'active'")
      .bind(backup.org_id)
      .all<{ invited_email: string }>();
    const copy = COPY[backup.locale] ?? COPY.nl;
    const since = backup.since.slice(0, 16).replace('T', ' ');
    for (const { invited_email } of admins ?? []) {
      try {
        await sendOrgEmail(env, backup.org_id, { to: invited_email, subject: copy.subject(backup.name), text: copy.text(backup.name, since, env.PUBLIC_BASE_URL) });
      } catch (err) {
        console.error('Backup warning not sent', backup.org_id, err);
      }
    }
    await env.DB.prepare("UPDATE sync_links SET warned_at = ? WHERE org_id = ? AND role = 'replica'").bind(new Date(now).toISOString(), backup.org_id).run();
    warned.push(backup.org_id);
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_links WHERE role = 'replica'").first<{ n: number }>();
  return { warned, backups: count?.n ?? 0 };
}

export class SyncWatch implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  // Wakes the watch; harmless when it's already awake.
  async fetch(): Promise<Response> {
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + CHECK_MS);
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    const { backups } = await checkBackups(this.env);
    if (backups > 0) await this.state.storage.setAlarm(Date.now() + CHECK_MS);
  }
}

export async function ensureSyncWatch(env: Env): Promise<void> {
  try {
    await env.SYNC_WATCH.get(env.SYNC_WATCH.idFromName('sync-watch')).fetch('https://sync-watch/start');
  } catch (err) {
    console.error('Could not wake the backup watch', err);
  }
}
