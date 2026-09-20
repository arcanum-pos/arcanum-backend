import type { Env } from '../env';
import { createOrganization, listMyOrganizations, listMyMemberships, getOrganization, updateBranding } from './organizations';
import { listMembers, inviteMember, updateMemberRole, removeMember } from './members';
import { getIdentityProvider, setIdentityProvider, handleResolveIdentityProviderForAuth } from './identity-providers';
import { listPaymentCredentials, setPaymentCredential } from './payment-credentials';
import { getSmtpCredentials, setSmtpCredentials } from './smtp-credentials';
import { getGmailApiCredentials, setGmailApiCredentials } from './gmail-api-credentials';
import { getMailProvider, setMailProvider } from './mail-provider';
import { testMailConfiguration } from './mail';
import { listEvents, createEvent } from './events';
import { getCustomDomain, setCustomDomain, verifyCustomDomain, removeCustomDomain } from './custom-domain';

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

  const orgMatch = pathname.match(/^\/organizations\/([^/]+)$/);
  if (orgMatch) {
    if (request.method === 'GET') return getOrganization(request, env, orgMatch[1]);
    return null;
  }

  const brandingMatch = pathname.match(/^\/organizations\/([^/]+)\/branding$/);
  if (brandingMatch && request.method === 'PATCH') {
    return updateBranding(request, env, brandingMatch[1]);
  }

  const customDomainVerifyMatch = pathname.match(/^\/organizations\/([^/]+)\/custom-domain\/verify$/);
  if (customDomainVerifyMatch && request.method === 'POST') {
    return verifyCustomDomain(request, env, customDomainVerifyMatch[1]);
  }

  const customDomainMatch = pathname.match(/^\/organizations\/([^/]+)\/custom-domain$/);
  if (customDomainMatch) {
    if (request.method === 'GET') return getCustomDomain(request, env, customDomainMatch[1]);
    if (request.method === 'PUT') return setCustomDomain(request, env, customDomainMatch[1]);
    if (request.method === 'DELETE') return removeCustomDomain(request, env, customDomainMatch[1]);
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

  // Pre-authentication lookup for questo-bff to drive a login — gated by
  // BFF_INTERNAL_KEY, not caller identity (see identity-providers.ts's
  // comment on handleResolveIdentityProviderForAuth for why that matters).
  // Checked before the plain /identity-provider match below.
  const idpResolveMatch = pathname.match(/^\/organizations\/([^/]+)\/identity-provider\/resolve$/);
  if (idpResolveMatch && request.method === 'GET') {
    return handleResolveIdentityProviderForAuth(request, env, idpResolveMatch[1]);
  }

  const idpMatch = pathname.match(/^\/organizations\/([^/]+)\/identity-provider$/);
  if (idpMatch) {
    if (request.method === 'GET') return getIdentityProvider(request, env, idpMatch[1]);
    if (request.method === 'PUT') return setIdentityProvider(request, env, idpMatch[1]);
    return null;
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
