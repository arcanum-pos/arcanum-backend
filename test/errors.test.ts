// User-facing errors carry a stable `code` (+ `params`) next to the
// unchanged Dutch `error` text — see src/errors.ts.
import { describe, expect, it } from 'vitest';
import { ERROR_TEXTS, errorText, type ErrorCode } from '../src/errors';
import { api, chargeCash, createTab, DEVICE, line, seedOrg, tabsPath, testMenu } from './helpers';

const codes = Object.keys(ERROR_TEXTS) as ErrorCode[];

describe('the error table', () => {
  it('has a non-empty Dutch text for every snake_case code, and no duplicate texts', () => {
    expect(codes.length).toBeGreaterThan(40);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(ERROR_TEXTS[code].trim().length).toBeGreaterThan(0);
    }
    const texts = codes.map((c) => ERROR_TEXTS[c]);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('only uses simple {name} placeholders', () => {
    for (const code of codes) {
      const text = ERROR_TEXTS[code];
      const stripped = text.replace(/\{[a-zA-Z]+\}/g, '');
      expect(stripped, code).not.toMatch(/[{}]/);
    }
  });

  it('fills placeholders into exactly the texts the API always sent', () => {
    // The right-hand sides are the template literals as they were before codes existed.
    const table = 'tabs';
    const version = 7;
    const expected = 1;
    const max = 500;
    const n = 19;
    expect(errorText('export_version_unsupported', { version, expected })).toBe(`Exportversie ${version} wordt niet ondersteund (verwacht ${expected})`);
    expect(errorText('import_invalid_count', { table })).toBe(`Ongeldig aantal voor ${table}`);
    expect(errorText('import_too_many_chunk_rows', { max: 2000 })).toBe(`Maximaal ${2000} rijen per stuk`);
    expect(errorText('import_too_many_rows', { max })).toBe(`Maximaal ${max} rijen per bestand`);
    expect(errorText('import_too_long', { field: 'Groep', max: 60 })).toBe(`${'Groep'} is te lang (max ${60} tekens)`);
    expect(errorText('import_price_invalid', { value: 'acht' })).toBe(`Prijs "${'acht'}" is geen geldig bedrag`);
    expect(errorText('import_vat_not_a_number', { value: 'x' })).toBe(`BTW "${'x'}" is geen getal`);
    expect(errorText('import_vat_unknown', { value: n, allowed: [0, 6, 12, 21].join(', ') })).toBe(`BTW ${n}% bestaat niet — gebruik ${[0, 6, 12, 21].join(', ')}`);
    expect(errorText('import_quick_invalid', { value: 'veel' })).toBe(`Snelknoppen "${'veel'}" — gebruik hele getallen tussen 1 en 999, bv. 5, 10, 20 (max 10)`);
    expect(errorText('import_visible_invalid', { value: 'misschien' })).toBe(`Zichtbaar "${'misschien'}" — gebruik ja of nee`);
    const fp = { name: 'Steak', categorie: { row: 2, value: 'Eten' } };
    const r = { categorie: 'Kinderen' };
    const row = 3;
    expect(errorText('import_category_conflict', { product: fp.name, value: r.categorie, otherRow: fp.categorie.row, otherValue: fp.categorie.value, row })).toBe(
      `${fp.name}: andere categorie ("${r.categorie}") dan op rij ${fp.categorie.row} ("${fp.categorie.value}") — rijen ${fp.categorie.row} en ${row}`
    );
    expect(errorText('import_station_conflict', { product: fp.name, value: 'Bar', otherRow: 2, otherValue: 'Keuken', row })).toBe(
      `${fp.name}: ander station ("${'Bar'}") dan op rij ${2} ("${'Keuken'}") — rijen ${2} en ${row}`
    );
    expect(errorText('import_vat_conflict', { product: fp.name, value: '21%', otherRow: 2, otherValue: '(geen)', row })).toBe(
      `${fp.name}: ander BTW-tarief (${'21%'}) dan op rij ${2} (${'(geen)'}) — rijen ${2} en ${row}`
    );
    expect(errorText('import_duplicate_variant', { name: 'Pils', otherRow: 2 })).toBe(`${'Pils'} staat al op rij ${2}`);
    expect(errorText('import_duplicate_code', { code: 'c', otherRow: 4 })).toBe(`Code "${'c'}" staat al op rij ${4}`);
    expect(errorText('import_code_other_product', { code: 'c', owner: 'Cola', product: 'Fanta' })).toBe(
      `Code "${'c'}" hoort bij product "${'Cola'}", niet bij "${'Fanta'}" (dat bestaat al apart)`
    );
    expect(errorText('import_same_existing_product', { product: 'A', other: 'B', existing: 'C' })).toBe(`"${'A'}" en "${'B'}" verwijzen naar hetzelfde bestaande product "${'C'}"`);
    expect(errorText('import_code_in_use', { code: 'c' })).toBe(`Code "${'c'}" is al in gebruik bij een ander product`);
    expect(errorText('import_variant_claimed', { otherRow: 2 })).toBe(`Deze variant staat al op rij ${2}`);
  });

  it('leaves a missing placeholder visible instead of throwing', () => {
    expect(errorText('import_invalid_count')).toBe('Ongeldig aantal voor {table}');
  });
});

describe('coded error responses', () => {
  it('tabs: tab_not_found, unknown_event, tab_changed (with the current tab), product_not_on_catalog', async () => {
    const org = await seedOrg();

    const missing = await api('GET', tabsPath(org.orgId, '/nope'), { user: org.cashier });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Rekening niet gevonden', code: 'tab_not_found' });

    const badEvent = await api('POST', tabsPath(org.orgId), { user: org.cashier, body: { ...DEVICE, eventId: 'bestaat-niet' } });
    expect(badEvent.status).toBe(400);
    expect(badEvent.body).toEqual({ error: 'Onbekend evenement — kies het opnieuw in de instellingen van de kassa', code: 'unknown_event' });

    const tab = await createTab(org, { lines: [line('pils', 'Pils', 250, 2)] });
    const stale = await chargeCash(org, tab.id, 999);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'Rekening is gewijzigd, herlaad en probeer opnieuw', code: 'tab_changed', tab: { id: tab.id } });

    const menu = await testMenu(org);
    const unknownLine = await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), {
      user: org.cashier,
      body: { ...DEVICE, catalogId: menu.catalogId, lines: [{ variantId: 'weg', quantity: 1 }] },
    });
    expect(unknownLine.status).toBe(400);
    expect(unknownLine.body).toEqual({ error: 'Dit product staat niet (meer) op de menukaart — herlaad de kassa', code: 'product_not_on_catalog' });

    // A developer-facing error stays plain.
    const malformed = await api('POST', tabsPath(org.orgId, `/${tab.id}/orders`), { user: org.cashier, body: { lines: [] } });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'lines must be a non-empty array' });
  });

  it('a second payment on the same tab: tab_payment_already_pending', async () => {
    const org = await seedOrg();
    const tab = await createTab(org, { lines: [line('pils', 'Pils', 250, 1)] });
    expect((await chargeCash(org, tab.id, 250)).status).toBe(201);
    const again = await chargeCash(org, tab.id, 250);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'Er loopt al een betaling voor deze rekening', code: 'tab_payment_already_pending' });
  });

  it('catalog: catalog_not_found and code_in_use', async () => {
    const org = await seedOrg();
    const missing = await api('GET', `/organizations/${org.orgId}/catalogs/bestaat-niet`, { user: org.admin });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Menukaart niet gevonden', code: 'catalog_not_found' });

    const products = `/organizations/${org.orgId}/catalog/products`;
    expect((await api('POST', products, { user: org.admin, body: { name: 'Cola', variants: [{ name: '', code: 'c1' }] } })).status).toBe(201);
    const clash = await api('POST', products, { user: org.admin, body: { name: 'Fanta', variants: [{ name: '', code: 'c1' }] } });
    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({ error: 'Deze code wordt al gebruikt', code: 'code_in_use' });
  });

  it('catalog import: every row error has a code and params that rebuild its message', async () => {
    const org = await seedOrg();
    const res = await api('POST', `/organizations/${org.orgId}/catalogs/import`, {
      user: org.admin,
      body: {
        name: 'Fout',
        dryRun: true,
        rows: [
          { row: 2, groep: 'G', product: 'A', variant: '', prijs: 'acht' },
          { row: 3, groep: null, product: 'B', variant: '', prijs: 1, btw: 19 },
          { row: 4, groep: null, product: 'C', variant: '', prijs: 1, snelknoppen: 'veel', zichtbaar: 'misschien' },
          { row: 5, groep: null, product: 'D', variant: '', prijs: 1, categorie: 'Eten' },
          { row: 6, groep: null, product: 'D', variant: 'groot', prijs: 1, categorie: 'Drank' },
        ],
      },
    });
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries(res.body.errors.map((e: any) => [e.code, e]));
    expect(Object.keys(byCode).sort()).toEqual(
      ['import_category_conflict', 'import_price_invalid', 'import_quick_invalid', 'import_vat_unknown', 'import_visible_invalid'].sort()
    );
    expect(byCode.import_price_invalid).toEqual({ row: 2, message: 'Prijs "acht" is geen geldig bedrag', code: 'import_price_invalid', params: { value: 'acht' } });
    expect(byCode.import_vat_unknown.params).toEqual({ value: 19, allowed: '0, 6, 12, 21' });
    expect(byCode.import_category_conflict).toMatchObject({
      row: 6,
      message: 'D: andere categorie ("Drank") dan op rij 5 ("Eten") — rijen 5 en 6',
      params: { product: 'D', value: 'Drank', otherRow: 5, otherValue: 'Eten', row: 6 },
    });
    for (const e of res.body.errors) expect(errorText(e.code, e.params)).toBe(e.message);

    const tooMany = await api('POST', `/organizations/${org.orgId}/catalogs/import`, {
      user: org.admin,
      body: { name: 'Groot', rows: Array.from({ length: 501 }, (_, i) => ({ row: i + 2, groep: 'G', product: `P${i}`, prijs: 1 })) },
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toEqual({ error: 'Maximaal 500 rijen per bestand', code: 'import_too_many_rows', params: { max: 500 } });
  });

  it('org import: not_an_export and export_version_unsupported with params', async () => {
    const org = await seedOrg();
    const start = (manifest: unknown) => api('POST', '/organizations/import/start', { user: org.admin, body: { manifest } });
    expect((await start({ format: 'iets anders' })).body).toEqual({ error: 'Dit is geen Arcanum-exportbestand', code: 'not_an_export' });
    expect((await start({ format: 'arcanum-org-export', version: 99 })).body).toEqual({
      error: 'Exportversie 99 wordt niet ondersteund (verwacht 1)',
      code: 'export_version_unsupported',
      params: { version: 99, expected: 1 },
    });
    expect((await start({ format: 'arcanum-org-export', version: 1, organization: { name: 'X' }, counts: { tabs: -1 } })).body).toEqual({
      error: 'Ongeldig aantal voor tabs',
      code: 'import_invalid_count',
      params: { table: 'tabs' },
    });
  });

  it('instance admins: not_instance_admin', async () => {
    const outsider = { sub: `u-${crypto.randomUUID()}`, issuer: 'https://issuer.test/', name: 'X', email: 'stranger@elsewhere.example' };
    const refused = await api('POST', '/organizations', { user: outsider, body: { name: 'Niet van ons' } });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      error: 'Alleen de beheerders van deze installatie kunnen een organisatie aanmaken of importeren',
      code: 'not_instance_admin',
    });
  });
});
