// User-facing errors: a stable machine `code` next to the Dutch `error`
// text, so a frontend can show the error in its own language (nl/fr/en)
// instead of the Dutch text verbatim — and stop regex-matching it.
//
// Response body: { error, code, params? , ...extra } — `error` is exactly
// the Dutch text the API always sent (older frontends keep working),
// `params` holds every value interpolated into it.
//
// Only errors meant for the person at the kassa / in the console get a
// code. English developer-facing errors ('orgId is required',
// 'Unauthorized', 'Forbidden', …) stay plain { error } — they signal a bug
// or a misbehaving client, not something to show a user.
import { json } from './http';

export type ErrorParams = Record<string, string | number | null>;

// code → Dutch text. `{name}` is filled from params[name].
export const ERROR_TEXTS = {
  // --- Tabs (rekeningen) ---
  tab_not_found: 'Rekening niet gevonden',
  tab_not_open: 'Rekening is niet meer open',
  tab_payment_pending: 'Er loopt een betaling voor deze rekening',
  tab_payment_already_pending: 'Er loopt al een betaling voor deze rekening',
  tab_changed: 'Rekening is gewijzigd, herlaad en probeer opnieuw',
  tab_nothing_to_pay: 'Niets te betalen op deze rekening',
  tab_not_empty: 'Alleen een lege rekening kan geannuleerd worden — annuleer eerst de lijnen',
  split_too_small: 'Te weinig open om zo te verdelen',
  unknown_event: 'Onbekend evenement — kies het opnieuw in de instellingen van de kassa',
  unknown_catalog: 'Onbekende of gearchiveerde menukaart',
  product_not_on_catalog: 'Dit product staat niet (meer) op de menukaart — herlaad de kassa',
  line_not_found: 'Lijn niet gevonden',
  nothing_to_void: 'Niets meer te annuleren op deze lijn',
  void_units_paid: 'Deze stuks zijn al betaald — ze kunnen niet meer geannuleerd worden',
  void_exceeds_outstanding: 'Er is al een deel betaald — annuleren zou meer terugbetalen dan er open staat',

  // --- Catalog: categories, stations, products, variants ---
  category_not_found: 'Categorie niet gevonden',
  category_in_use: 'Deze categorie wordt nog gebruikt door producten',
  unknown_category: 'Onbekende categorie',
  station_not_found: 'Station niet gevonden',
  station_in_use: 'Dit station wordt nog gebruikt door producten',
  station_name_taken: 'Er bestaat al een station met die naam',
  unknown_station: 'Onbekend station',
  product_not_found: 'Product niet gevonden',
  unknown_product: 'Onbekend of gearchiveerd product',
  variant_not_found: 'Variant niet gevonden',
  last_active_variant: 'Een product heeft minstens één actieve variant nodig — archiveer dan het product',
  code_in_use: 'Deze code wordt al gebruikt',
  product_code_taken: 'Een code van dit product wordt intussen door een ander product gebruikt',

  // --- Catalogs (menukaarten) ---
  catalog_not_found: 'Menukaart niet gevonden',
  no_catalog: 'Geen menukaart gevonden',
  default_catalog_not_archivable: 'De standaardmenukaart kan niet gearchiveerd worden — maak eerst een andere standaard',
  catalog_layout_changed: 'De indeling is intussen gewijzigd — herlaad en probeer opnieuw',
  section_not_found: 'Groep niet gevonden',
  unknown_section: 'Onbekende groep voor deze menukaart',
  product_already_on_catalog: 'Dit product staat al op deze menukaart',

  // --- Catalog import (spreadsheet). Row errors come back in `errors[]`
  // with the same code/params (plus `row`); see catalog-import.ts.
  import_too_many_rows: 'Maximaal {max} rijen per bestand',
  import_changed: 'Er is intussen iets gewijzigd (bv. een code wordt al gebruikt) — maak opnieuw een voorbeeld',
  import_group_missing: 'Groep ontbreekt (en er is geen rij erboven om van over te nemen)',
  import_product_missing: 'Product ontbreekt (en er is geen rij erboven om van over te nemen)',
  import_too_long: '{field} is te lang (max {max} tekens)',
  import_price_negative: 'Prijs moet 0 of meer zijn',
  import_price_too_high: 'Prijs is te hoog (max € 10.000)',
  import_price_missing: 'Prijs ontbreekt',
  import_price_invalid: 'Prijs "{value}" is geen geldig bedrag',
  import_vat_not_a_number: 'BTW "{value}" is geen getal',
  import_vat_unknown: 'BTW {value}% bestaat niet — gebruik {allowed}',
  import_quick_invalid: 'Snelknoppen "{value}" — gebruik hele getallen tussen 1 en 999, bv. 5, 10, 20 (max 10)',
  import_visible_invalid: 'Zichtbaar "{value}" — gebruik ja of nee',
  import_category_conflict: '{product}: andere categorie ("{value}") dan op rij {otherRow} ("{otherValue}") — rijen {otherRow} en {row}',
  import_station_conflict: '{product}: ander station ("{value}") dan op rij {otherRow} ("{otherValue}") — rijen {otherRow} en {row}',
  import_vat_conflict: '{product}: ander BTW-tarief ({value}) dan op rij {otherRow} ({otherValue}) — rijen {otherRow} en {row}',
  import_duplicate_variant: '{name} staat al op rij {otherRow}',
  import_duplicate_code: 'Code "{code}" staat al op rij {otherRow}',
  import_code_other_product: 'Code "{code}" hoort bij product "{owner}", niet bij "{product}" (dat bestaat al apart)',
  import_same_existing_product: '"{product}" en "{other}" verwijzen naar hetzelfde bestaande product "{existing}"',
  import_code_in_use: 'Code "{code}" is al in gebruik bij een ander product',
  import_variant_claimed: 'Deze variant staat al op rij {otherRow}',

  // --- Organisations, export / import ---
  org_not_found: 'Organisatie niet gevonden',
  not_instance_admin: 'Alleen de beheerders van deze installatie kunnen een organisatie aanmaken of importeren',
  // ORG_CREATION says no (demo instance, or an own instance that already has its org) — see organizations/org-creation.ts.
  org_creation_disabled: 'Op deze installatie kunnen geen nieuwe organisaties aangemaakt worden',
  // Too many live demo orgs at once (DEMO_MAX_LIVE) — see demo-orgs.ts.
  demo_limit_reached: 'Er lopen nu te veel demo\'s tegelijk — probeer het over een tijdje opnieuw',
  not_an_export: 'Dit is geen Arcanum-exportbestand',
  export_version_unsupported: 'Exportversie {version} wordt niet ondersteund (verwacht {expected})',
  org_name_required: 'De organisatie heeft een naam nodig (max 100 tekens)',
  import_invalid_count: 'Ongeldig aantal voor {table}',
  not_importing: 'Deze organisatie wordt niet (meer) geïmporteerd',
  import_unknown_table: 'Onbekende tabel',
  import_too_many_chunk_rows: 'Maximaal {max} rijen per stuk',
  import_not_abortable: 'Alleen een onafgewerkte import kan geannuleerd worden',

  // --- Custom domain, identity provider, mail ---
  invalid_domain: 'Vul een geldige domeinnaam in (bv. pos.mijnorganisatie.be)',
  domain_requires_idp: 'Configureer eerst een eigen identity provider voor deze organisatie (zie Aanmelding) voordat je een aangepast domein instelt.',
  domain_in_use: 'Dit domein is al in gebruik door een andere organisatie',
  // Both: `error` is Cloudflare's own (English) message when it gave one —
  // then also in params.detail — else this text.
  domain_registration_failed: 'Kon domein niet registreren bij Cloudflare',
  domain_status_failed: 'Kon status niet ophalen bij Cloudflare',
  domain_routing_failed: 'Kon geen routing instellen voor dit domein bij Cloudflare',
  idp_discovery_failed: 'Kon de issuer-URL niet bereiken, of deze ondersteunt geen apparaatcode-aanmelding (vereist voor de kassa-toestellen).',
  mail_not_configured: 'Geen e-mailconfiguratie gevonden (en ook geen platform-standaard)',
  mail_send_failed: 'Verzenden mislukt',

  // --- Payments ---
  bancontact_not_configured: 'Bancontact niet geconfigureerd voor deze organisatie',
  // `error` is SumUp's own message when it gave one — then also in params.detail.
  sumup_readers_failed: 'Kon SumUp readers niet ophalen',
} as const satisfies Record<string, string>;

export type ErrorCode = keyof typeof ERROR_TEXTS;

export interface CodedError {
  error: string;
  code: ErrorCode;
  params?: ErrorParams;
}

// The Dutch text for a code, placeholders filled in. A missing param stays
// as its `{name}` (never throws — a test checks every use fills them).
export function errorText(code: ErrorCode, params?: ErrorParams): string {
  return ERROR_TEXTS[code].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    params && params[name] !== undefined ? String(params[name]) : placeholder
  );
}

export function codedError(code: ErrorCode, params?: ErrorParams): CodedError {
  return params ? { error: errorText(code, params), code, params } : { error: errorText(code), code };
}

// A coded error response; `extra` adds fields next to it (e.g. the current `tab`).
export function errorJson(error: ErrorCode | CodedError, status: number, extra?: Record<string, unknown>): Response {
  const body = typeof error === 'string' ? codedError(error) : error;
  return json(extra ? { ...body, ...extra } : body, status);
}

// A failure reported by an outside provider (Cloudflare, SumUp): `error`
// stays the provider's own message when it gave one (as the API always
// did), which is then also passed as params.detail; else the code's text.
export function providerErrorJson(code: ErrorCode, providerMessage: string | null | undefined, status: number, extra?: Record<string, unknown>): Response {
  const body: CodedError = providerMessage ? { error: providerMessage, code, params: { detail: providerMessage } } : codedError(code);
  return json(extra ? { ...extra, ...body } : body, status);
}

// For validators that return either a plain (developer-facing) message or a
// coded error.
export function errorBody(error: string | CodedError): { error: string } | CodedError {
  return typeof error === 'string' ? { error } : error;
}
