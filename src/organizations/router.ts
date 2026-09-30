import type { Env } from '../env';
import { createOrganization, listMyOrganizations, listMyMemberships, getOrganization, updateBranding } from './organizations';
import { listMembers, inviteMember, updateMemberRole, removeMember } from './members';
import { handleResolveIdentityProviderForAuth } from './identity-providers';
import { listPaymentCredentials, setPaymentCredential } from './payment-credentials';
import { getSmtpCredentials, setSmtpCredentials } from './smtp-credentials';
import { getGmailApiCredentials, setGmailApiCredentials } from './gmail-api-credentials';
import { getMailProvider, setMailProvider } from './mail-provider';
import { testMailConfiguration } from './mail';
import { listEvents, createEvent } from './events';
import { getOrgLocale, setOrgLocale } from './locale';
import { getCapabilities } from './org-creation';

// Handles every /organizations/* path. Returns null for anything it doesn't
// recognize, so the caller (the main router) can fall through to its own
// "Not found" response.
export async function dispatchOrganizationsRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname === '/organizations') {
    if (request.method === 'POST') return createOrganization(request, env);
    if (request.method === 'GET') return listMyOrganizations(request, env);
    return null;
  }

  // Checked before the generic /organizations/:id match below, since
  // "memberships" would otherwise be parsed as an organization id.
  if (pathname === '/organizations/memberships' && request.method === 'GET') {
    return listMyMemberships(request, env);
  }

  // Same reason: "capabilities" isn't an organization id.
  if (pathname === '/organizations/capabilities' && request.method === 'GET') {
    return getCapabilities(request, env);
  }

  const orgMatch = pathname.match(/^\/organizations\/([^/]+)$/);
  if (orgMatch) {
    if (request.method === 'GET') return getOrganization(request, env, orgMatch[1]);
    return null;
  }

  const brandingMatch = pathname.match(/^\/organizations\/([^/]+)\/branding$/);
  if (brandingMatch && request.method === 'PATCH') {
    return updateBranding(request, env, brandingMatch[1]);
  }

  const localeMatch = pathname.match(/^\/organizations\/([^/]+)\/locale$/);
  if (localeMatch) {
    if (request.method === 'GET') return getOrgLocale(request, env, localeMatch[1]);
    if (request.method === 'PUT') return setOrgLocale(request, env, localeMatch[1]);
    return null;
  }

  const membersMatch = pathname.match(/^\/organizations\/([^/]+)\/members$/);
  if (membersMatch) {
    if (request.method === 'GET') return listMembers(request, env, membersMatch[1]);
    if (request.method === 'POST') return inviteMember(request, env, membersMatch[1]);
    return null;
  }

  const memberMatch = pathname.match(/^\/organizations\/([^/]+)\/members\/([^/]+)$/);
  if (memberMatch) {
    if (request.method === 'PATCH') return updateMemberRole(request, env, memberMatch[1], memberMatch[2]);
    if (request.method === 'DELETE') return removeMember(request, env, memberMatch[1], memberMatch[2]);
    return null;
  }

  // Legacy path of the bff's pre-authentication login lookup — the org/host
  // segment is ignored (one identity provider per instance). See
  // identity-providers.ts's handleResolveIdentityProviderForAuth; the
  // current path, /identity-provider/resolve, is routed in index.ts.
  if (/^\/organizations\/[^/]+\/identity-provider\/resolve$/.test(pathname) && request.method === 'GET') {
    return handleResolveIdentityProviderForAuth(request, env, true);
  }

  const credsMatch = pathname.match(/^\/organizations\/([^/]+)\/payment-credentials$/);
  if (credsMatch && request.method === 'GET') {
    return listPaymentCredentials(request, env, credsMatch[1]);
  }

  const credMatch = pathname.match(/^\/organizations\/([^/]+)\/payment-credentials\/([^/]+)$/);
  if (credMatch && request.method === 'PUT') {
    return setPaymentCredential(request, env, credMatch[1], credMatch[2]);
  }

  // Provider-agnostic — tests whichever transport (SMTP or Gmail API) is
  // currently active for the org. Checked before the plain /smtp-credentials
  // match below.
  const mailTestMatch = pathname.match(/^\/organizations\/([^/]+)\/smtp-credentials\/test$/);
  if (mailTestMatch && request.method === 'POST') {
    return testMailConfiguration(request, env, mailTestMatch[1]);
  }

  const smtpMatch = pathname.match(/^\/organizations\/([^/]+)\/smtp-credentials$/);
  if (smtpMatch) {
    if (request.method === 'GET') return getSmtpCredentials(request, env, smtpMatch[1]);
    if (request.method === 'PUT') return setSmtpCredentials(request, env, smtpMatch[1]);
    return null;
  }

  const gmailApiMatch = pathname.match(/^\/organizations\/([^/]+)\/gmail-api-credentials$/);
  if (gmailApiMatch) {
    if (request.method === 'GET') return getGmailApiCredentials(request, env, gmailApiMatch[1]);
    if (request.method === 'PUT') return setGmailApiCredentials(request, env, gmailApiMatch[1]);
    return null;
  }

  const mailProviderMatch = pathname.match(/^\/organizations\/([^/]+)\/mail-provider$/);
  if (mailProviderMatch) {
    if (request.method === 'GET') return getMailProvider(request, env, mailProviderMatch[1]);
    if (request.method === 'PUT') return setMailProvider(request, env, mailProviderMatch[1]);
    return null;
  }

  const eventsMatch = pathname.match(/^\/organizations\/([^/]+)\/events$/);
  if (eventsMatch) {
    if (request.method === 'GET') return listEvents(request, env, eventsMatch[1]);
    if (request.method === 'POST') return createEvent(request, env, eventsMatch[1]);
    return null;
  }

  return null;
}
