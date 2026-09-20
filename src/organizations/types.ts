export type OrgRole = 'admin' | 'cashier';
export type MembershipStatus = 'pending' | 'active';

export interface CallerIdentity {
  sub: string;
  // Which issuer authenticated this sub — see idp-resolution.ts and the
  // migration note on memberships.issuer for why this matters.
  issuer: string;
  email: string;
  name: string;
}

export interface OrganizationRow {
  id: string;
  name: string;
  logo_url: string | null;
  theme: string | null;
  slug: string | null;
  dek_ciphertext: string;
  dek_iv: string;
  created_at: string;
  created_by_sub: string;
  // See organizations/custom-domain.ts. custom_domain_cf_id is Cloudflare's
  // Custom Hostname id (needed to poll/delete it) — never shown to the
  // admin. custom_domain_status/ssl_status mirror Cloudflare's own
  // `status`/`ssl.status` fields, refreshed only when the admin clicks
  // Verify (no background polling).
  custom_domain: string | null;
  custom_domain_cf_id: string | null;
  custom_domain_status: string | null;
  custom_domain_ssl_status: string | null;
}

export interface MembershipRow {
  id: string;
  org_id: string;
  user_sub: string | null;
  issuer: string | null;
  invited_email: string;
  role: OrgRole;
  status: MembershipStatus;
  invited_at: string;
  accepted_at: string | null;
}

export interface IdentityProviderRow {
  org_id: string;
  connection_name: string | null;
  issuer_url: string | null;
  client_id: string | null;
  client_secret_ciphertext: string | null;
  client_secret_iv: string | null;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  userinfo_endpoint: string | null;
  device_authorization_endpoint: string | null;
  end_session_endpoint: string | null;
  scopes: string | null;
  // Optional override, used only for the authorization-code flow (browser
  // /login, and /:orgId/console) — the device grant always uses client_id/
  // client_secret_ciphertext above. Needed because some providers (Google)
  // require a different OAuth client per flow, unlike Auth0 where one
  // Application can do both. NULL/unset means "use the fields above for
  // both flows" — see resolveIdentityProviderForAuth's `purpose` param.
  auth_code_client_id: string | null;
  auth_code_client_secret_ciphertext: string | null;
  auth_code_client_secret_iv: string | null;
  updated_at: string;
}

export type PaymentProvider = 'bancontact' | 'sumup';

export interface PaymentProviderCredentialRow {
  org_id: string;
  provider: PaymentProvider;
  config_ciphertext: string;
  config_iv: string;
  updated_at: string;
}

export interface SmtpCredentialRow {
  org_id: string;
  host: string | null;
  port: number | null;
  username: string | null;
  password_ciphertext: string | null;
  password_iv: string | null;
  from_address: string | null;
  from_name: string | null;
  updated_at: string;
}

export type MailProvider = 'smtp' | 'gmail_api';

export interface MailProviderRow {
  org_id: string;
  provider: MailProvider;
  updated_at: string;
}

// Domain-wide-delegated service account: client_email + private_key sign a
// short-lived JWT (see questo-mail/src/mailer/gmail-api.ts), exchanged for
// an OAuth2 access token, then used to call the Gmail API impersonating
// impersonated_user. No SMTP, no DNS/SPF/DKIM changes — Google's own
// already-authorized sending path for the domain.
export interface GmailApiCredentialRow {
  org_id: string;
  client_email: string | null;
  private_key_ciphertext: string | null;
  private_key_iv: string | null;
  impersonated_user: string | null;
  from_name: string | null;
  updated_at: string;
}
