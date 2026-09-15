// Content lives here (in `worker`, alongside the invite logic that
// triggers it), not in questo-mail — that Worker is a pure transport
// ("send this to/subject/text/html"), it has no business knowing what an
// invite email says.
//
// No accept-link/token needed: reconcilePendingInvites (see
// organizations/members.ts) already activates a pending membership the
// moment its invited email logs in — the call to action is just "log in",
// not a one-time link.
const ROLE_LABELS: Record<string, string> = { admin: 'beheerder', cashier: 'kassier' };

export interface InviteEmailContent {
  subject: string;
  text: string;
  html: string;
}

export function buildInviteEmail(params: { orgName: string; role: string; loginUrl: string }): InviteEmailContent {
  const roleLabel = ROLE_LABELS[params.role] ?? params.role;

  const subject = `Uitnodiging voor ${params.orgName}`;

  const text = [
    `Je bent uitgenodigd om lid te worden van ${params.orgName} op Questo, als ${roleLabel}.`,
    '',
    `Meld je aan om je uitnodiging te activeren: ${params.loginUrl}`,
    '',
    'Gebruik hetzelfde e-mailadres waarop je deze uitnodiging ontvangen hebt.',
  ].join('\n');

  const html = `
    <p>Je bent uitgenodigd om lid te worden van <strong>${escapeHtml(params.orgName)}</strong> op Questo, als ${escapeHtml(roleLabel)}.</p>
    <p><a href="${escapeHtml(params.loginUrl)}">Meld je aan om je uitnodiging te activeren</a></p>
    <p>Gebruik hetzelfde e-mailadres waarop je deze uitnodiging ontvangen hebt.</p>
  `.trim();

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
