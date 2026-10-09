import type { Env } from '../env';
import { createOrganization, listMyOrganizations, listMyMemberships, getOrganization, updateBranding } from './organizations';
import { listMembers, inviteMember, updateMemberRole, removeMember } from './members';
import { listPaymentCredentials, setPaymentCredential } from './payment-credentials';
import { testInstallationMail } from './mail';
import { listEvents, createEvent } from './events';
import { getOrgLocale, setOrgLocale } from './locale';
import { getCapabilities } from './org-creation';
import { dispatchDeviceRoute } from '../devices';

// Handles every /organizations/* path. Returns null for anything it doesn't
// recognize, so the caller (the main router) can fall through to its own
// "Not found" response.
export async function dispatchOrganizationsRoute(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname === '/organizations') {
    if (request.method === 'POST') return createOrganization(request, env);
    if (request.method === 'GET') return listMyOrganizations(request, env);
    return null;
  }

  // Devices and their pairing codes (devices.ts) — incl. the claim, whose
  // "device-pairings" isn't an organization id.
  const deviceResponse = await dispatchDeviceRoute(request, env, pathname);
  if (deviceResponse) return deviceResponse;

  // Checked before the generic /organizations/:id match below, since
  // "memberships" would otherwise be parsed as an organization id.
  if (pathname === '/organizations/memberships' && request.method === 'GET') {
    return listMyMemberships(request, env);
  }

  // The installer's test mail (MAIL.md) — not an organization id either.
  if (pathname === '/organizations/mail-test' && request.method === 'POST') {
    return testInstallationMail(request, env);
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

  const credsMatch = pathname.match(/^\/organizations\/([^/]+)\/payment-credentials$/);
  if (credsMatch && request.method === 'GET') {
    return listPaymentCredentials(request, env, credsMatch[1]);
  }

  const credMatch = pathname.match(/^\/organizations\/([^/]+)\/payment-credentials\/([^/]+)$/);
  if (credMatch && request.method === 'PUT') {
    return setPaymentCredential(request, env, credMatch[1], credMatch[2]);
  }

  const eventsMatch = pathname.match(/^\/organizations\/([^/]+)\/events$/);
  if (eventsMatch) {
    if (request.method === 'GET') return listEvents(request, env, eventsMatch[1]);
    if (request.method === 'POST') return createEvent(request, env, eventsMatch[1]);
    return null;
  }

  return null;
}
