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
  import_product_ambiguous: '"{product}" staat in meer dan één categorie — vul op deze rij de categorie in',
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

  // --- Staff on shared devices (DOMAIN_MODEL.md, release B1) ---
  staff_required: 'Kies eerst wie er werkt (bovenaan het scherm)',
  staff_not_found: 'Medewerker niet gevonden',
  staff_name_required: 'Geef de medewerker een naam',
  staff_name_taken: 'Er is al een medewerker met die naam',
  staff_pin_invalid: 'Een pincode heeft 4 tot 6 cijfers',
  staff_pin_wrong: 'Verkeerde pincode',
  staff_pin_too_many: 'Te veel verkeerde pincodes — wacht een minuut',
  member_not_found: 'Lid niet gevonden',

  // --- Registers, shifts and kasopmaak (DOMAIN_MODEL.md, release B2) ---
  register_not_found: 'Kassa (lade) niet gevonden — kies ze opnieuw in de instellingen',
  register_closed: 'Deze kassa is niet open — doe eerst "Kassa openen"',
  register_name_required: 'Geef de kassa een naam',
  register_open: 'Deze kassa is nog open — doe eerst de kasopmaak',
  shift_not_found: 'Shift niet gevonden',
  shift_closed: 'Deze shift is al afgesloten',
  shift_already_open: 'Deze kassa werd net geopend op een ander toestel',
  shift_count_invalid: 'Deze telling klopt niet',
  shift_payment_pending: 'Er loopt nog een betaling op deze kassa — rond die eerst af',
  shift_note_required: 'Er is een verschil: schrijf erbij wat er gebeurd is',
  movement_invalid: 'Geef een bedrag en een reden',

  // --- Tables and waiters (DOMAIN_MODEL.md, release C) ---
  table_not_found: 'Tafel niet gevonden',
  table_name_required: 'Geef de tafel een naam',
  table_name_taken: 'Er is al een tafel met die naam',
  table_occupied: 'Aan deze tafel zitten al gasten',
  table_not_cleared: 'Deze tafel moet eerst opgeruimd worden',
  no_table_mode: 'Dit evenement heeft geen bestelwijze "aan tafel" met een menukaart — stel er een in bij het evenement',
  table_not_occupied: 'Aan deze tafel zit niemand',
  table_merge_paid: 'Er is al (een deel) betaald op een van deze tafels — samenvoegen kan dan niet',
  table_free: 'Deze tafel is vrij — plaats de gasten meteen',

  // --- Self-ordering and station screens (DOMAIN_MODEL.md) ---
  ticket_not_found: 'Bon niet gevonden',
  event_not_found: 'Evenement niet gevonden',
  self_order_needs_menu: 'Kies eerst een menukaart voor dit evenement',
  self_order_needs_catalog: 'Maak eerst een menukaart (Menukaarten)',
  self_order_needs_payment: 'Kies minstens één manier om te betalen',
  self_order_payment_unavailable: 'Op deze manier betalen kan hier niet',
  self_order_closed: 'Bestellen kan hier nu niet',
  self_order_busy: 'Er staan te veel onbetaalde bestellingen open — probeer het zo meteen opnieuw, of bestel aan de toog',
  self_order_too_large: 'Te veel in één bestelling — bestel de rest apart',
  order_not_found: 'Bestelling niet gevonden',
  order_mode_not_found: 'Bestelwijze niet gevonden',
  order_mode_needs_name: 'Geef de bestelwijze een naam',
  too_many_order_modes: 'Maximaal {max} bestelwijzen per evenement',
  unknown_order_mode: 'Onbekende bestelwijze — kies ze opnieuw',
  order_mode_required: 'Kies eerst hoe je bestelt',
  self_order_link_name: 'Geef een naam voor de link',
  tab_contact_name: 'Geef je naam voor je rekening',
  tab_contact_reach: 'Geef je gsm-nummer of e-mailadres voor je rekening',
  sms_not_configured: 'Sms is niet ingesteld voor deze installatie (installer → Geavanceerd → Sms)',
  sms_unavailable: 'Een sms kan voor deze bestelling niet',
  invalid_phone: 'Dat is geen gsm-nummer dat we kunnen gebruiken (begint met {countries}, of met 0)',

  // --- Mail ---
  mail_not_configured: 'Geen e-mailconfiguratie gevonden (en ook geen platform-standaard)',
  mail_send_failed: 'Verzenden mislukt',
  invalid_email: 'Dat is geen geldig e-mailadres',
  too_many_test_mails: 'Te veel testmails — probeer het over een uur opnieuw',

  // --- Payments ---
  bancontact_not_configured: 'Bancontact niet geconfigureerd voor deze organisatie',
  bancontact_key_refused: 'Bancontact aanvaardt deze sleutel niet — kijk of hij juist is en bij de gekozen omgeving hoort',
  bancontact_no_account: 'Bancontact zei niet bij welk account deze sleutel hoort — probeer opnieuw',
  bancontact_confirm_account: 'Bevestig het account waarop deze sleutel uitbetaalt',
  sumup_key_refused: 'SumUp aanvaardt deze sleutel niet voor deze merchant code — kijk ze allebei na',
  sumup_confirm_account: 'Bevestig het SumUp-account van deze merchant code en sleutel',
  bancontact_wrong_account: 'Deze Bancontact-betaling ging naar een ander account dan het bevestigde — ze werd geannuleerd. Kijk de sleutel na bij Instellingen → Betalingen.',
  // `error` is SumUp's own message when it gave one — then also in params.detail.
  sumup_readers_failed: 'Kon SumUp readers niet ophalen',
  sumup_not_configured: 'SumUp is niet ingesteld voor deze organisatie',
  push_unavailable: 'Meldingen zijn niet mogelijk voor deze bestelling',
  push_subscription_invalid: 'Deze browser gaf geen bruikbaar meldingsadres',
  tap_needs_kassa: 'Kies de kassa waarvoor deze Tap to Pay-telefoon is',
  tap_payment_not_found: 'Deze betaling bestaat niet (meer)',
  tap_payment_not_manual: 'Een Tap to Pay-betaling wordt bevestigd door SumUp, niet aan de kassa',
  sumup_app_not_configured: 'Tap to Pay is niet ingesteld: vul in de console de affiliate key van SumUp in',
  sumup_affiliate_key_invalid: 'Dat lijkt geen affiliate key of app-id van SumUp — kijk ze na',
  sumup_pairing_code_invalid: 'Een koppelcode bestaat uit 8 of 9 letters en cijfers',
  // `error` is SumUp's own message when it gave one — then also in params.detail.
  sumup_pair_failed: 'Koppelen van de reader mislukt',
  sumup_remove_failed: 'Loskoppelen van de reader mislukt',

  // --- Devices (devices.ts) ---
  device_name_required: 'Geef het toestel een naam',
  device_not_found: 'Dit toestel is niet (meer) gekoppeld aan deze organisatie',
  device_paired_elsewhere: 'Dit toestel werd elders opnieuw gekoppeld',
  icon_slot_unknown: 'Voor deze pagina kan je geen icoon instellen',
  icon_invalid: 'Dit icoon kon niet bewaard worden ({size} px): kies een andere afbeelding',
  pairing_code_invalid: 'Deze koppelcode klopt niet, is al gebruikt of is verlopen — vraag een beheerder om een nieuwe',
  pairing_too_many_attempts: 'Te veel foute koppelcodes — probeer over 10 minuten opnieuw',
  pairing_needs_login: 'Een kassa koppel je terwijl je aangemeld bent — meld je eerst aan',
  pairing_not_member: 'Je bent geen lid van de organisatie van deze koppelcode — meld je aan met het juiste account',
  devicehub_failed: 'Toestellen zijn even niet bereikbaar — probeer opnieuw'
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
