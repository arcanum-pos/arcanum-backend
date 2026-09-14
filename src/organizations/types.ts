export type OrgRole = 'admin' | 'cashier';
export type MembershipStatus = 'pending' | 'active';

export interface CallerIdentity {
  sub: string;
  email: string;
  name: string;
}

export interface OrganizationRow {
  id: string;
  name: string;
  logo_url: string | null;
  theme: string | null;
  dek_ciphertext: string;
  dek_iv: string;
  created_at: string;
  created_by_sub: string;
}

export interface MembershipRow {
  id: string;
  org_id: string;
  user_sub: string | null;
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
