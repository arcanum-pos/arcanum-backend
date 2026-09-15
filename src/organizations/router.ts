import type { Env } from '../env';
import { createOrganization, listMyOrganizations, listMyMemberships, getOrganization, updateBranding } from './organizations';
import { listMembers, inviteMember, updateMemberRole, removeMember } from './members';
import { getIdentityProvider, setIdentityProvider, handleResolveIdentityProviderForAuth } from './identity-providers';
import { listPaymentCredentials, setPaymentCredential } from './payment-credentials';
import { getSmtpCredentials, setSmtpCredentials, testSmtpCredentials } from './smtp-credentials';

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

  // Checked before the plain /smtp-credentials match below.
  const smtpTestMatch = pathname.match(/^\/organizations\/([^/]+)\/smtp-credentials\/test$/);
  if (smtpTestMatch && request.method === 'POST') {
    return testSmtpCredentials(request, env, smtpTestMatch[1]);
  }

  const smtpMatch = pathname.match(/^\/organizations\/([^/]+)\/smtp-credentials$/);
  if (smtpMatch) {
    if (request.method === 'GET') return getSmtpCredentials(request, env, smtpMatch[1]);
    if (request.method === 'PUT') return setSmtpCredentials(request, env, smtpMatch[1]);
    return null;
  }

  return null;
}
