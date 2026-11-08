// The example menukaart: a small café / club bar in nl, fr or en. The demo
// instance seeds every demo org with it (demo-orgs.ts); an own
// installation's first admin gets it with their organization (on by
// default) or later from the console's "Aan de slag" (onboarding.ts).
// Written as one json_each statement per table - a handful of queries
// whatever the menu's size (Workers Free: 50 per invocation).
import type { Locale } from './locale';
import { jsonRowsStatement, present } from '../sql-json';

export type Text = Record<Locale, string>;

export const t = (nl: string, fr: string, en: string): Text => ({ nl, fr, en });

const CATALOG_NAME = t('Menukaart', 'Carte', 'Menu');

const CATEGORIES = { drinks: t('Drank', 'Boissons', 'Drinks'), food: t('Eten', 'Nourriture', 'Food'), tokens: t('Bonnen', 'Jetons', 'Tokens') };
const STATIONS = { bar: t('Bar', 'Bar', 'Bar'), kitchen: t('Keuken', 'Cuisine', 'Kitchen') };
// Kassa layout, in order.
const SECTIONS = { drinks: t('Drank', 'Boissons', 'Drinks'), food: t('Eten', 'Plats', 'Food'), tokens: t('Bonnen', 'Jetons', 'Tokens') };

interface ExampleProduct {
  name: Text;
  category: keyof typeof CATEGORIES;
  station: keyof typeof STATIONS | null;
  section: keyof typeof SECTIONS;
  vatRateBp: number;
  variants: { name: Text | null; priceCents: number; quick?: number[] }[];
}

// A small café / club bar: drinks at 21%, food eaten in at 12% (Belgium).
const PRODUCTS: ExampleProduct[] = [
  {
    name: t('Pils', 'Pils', 'Lager'),
    category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100,
    variants: [{ name: t('25 cl', '25 cl', '25 cl'), priceCents: 250 }, { name: t('50 cl', '50 cl', '50 cl'), priceCents: 450 }],
  },
  { name: t('Tripel', 'Triple', 'Tripel'), category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100, variants: [{ name: null, priceCents: 400 }] },
  {
    name: t('Wijn', 'Vin', 'Wine'),
    category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100,
    variants: [{ name: t('rood', 'rouge', 'red'), priceCents: 400 }, { name: t('wit', 'blanc', 'white'), priceCents: 400 }, { name: t('rosé', 'rosé', 'rosé'), priceCents: 400 }],
  },
  {
    name: t('Frisdrank', 'Soft', 'Soft drink'),
    category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100,
    variants: [{ name: t('cola', 'cola', 'cola'), priceCents: 250 }, { name: t('limonade', 'limonade', 'lemonade'), priceCents: 250 }, { name: t('ice tea', 'thé glacé', 'iced tea'), priceCents: 250 }],
  },
  {
    name: t('Water', 'Eau', 'Water'),
    category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100,
    variants: [{ name: t('plat', 'plate', 'still'), priceCents: 200 }, { name: t('bruis', 'pétillante', 'sparkling'), priceCents: 200 }],
  },
  { name: t('Koffie', 'Café', 'Coffee'), category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100, variants: [{ name: null, priceCents: 250 }] },
  { name: t('Thee', 'Thé', 'Tea'), category: 'drinks', station: 'bar', section: 'drinks', vatRateBp: 2100, variants: [{ name: null, priceCents: 250 }] },
  {
    name: t('Croque', 'Croque', 'Toastie'),
    category: 'food', station: 'kitchen', section: 'food', vatRateBp: 1200,
    variants: [{ name: t('ham-kaas', 'jambon-fromage', 'ham & cheese'), priceCents: 600 }, { name: t('kaas', 'fromage', 'cheese'), priceCents: 550 }],
  },
  {
    name: t('Spaghetti bolognese', 'Spaghetti bolognaise', 'Spaghetti bolognese'),
    category: 'food', station: 'kitchen', section: 'food', vatRateBp: 1200,
    variants: [{ name: t('klein', 'petite', 'small'), priceCents: 900 }, { name: t('groot', 'grande', 'large'), priceCents: 1200 }],
  },
  { name: t('Soep van de dag', 'Soupe du jour', 'Soup of the day'), category: 'food', station: 'kitchen', section: 'food', vatRateBp: 1200, variants: [{ name: null, priceCents: 450 }] },
  {
    name: t('Pannenkoek', 'Crêpe', 'Pancake'),
    category: 'food', station: 'kitchen', section: 'food', vatRateBp: 1200,
    variants: [{ name: t('suiker', 'sucre', 'sugar'), priceCents: 400 }, { name: t('choco', 'chocolat', 'chocolate'), priceCents: 450 }],
  },
  // Nothing to prepare; sold in round numbers from the quick buttons.
  { name: t('Drankbon', 'Jeton boisson', 'Drink token'), category: 'tokens', station: null, section: 'tokens', vatRateBp: 2100, variants: [{ name: null, priceCents: 250, quick: [5, 10, 20] }] },
];

// Every row of the example menukaart for `orgId`, fresh ids, in `locale`.
export function exampleMenuRows(orgId: string, locale: Locale, createdAt: string) {
  const id = () => crypto.randomUUID();
  const ids = <K extends string>(keys: K[]) => Object.fromEntries(keys.map((k) => [k, id()])) as Record<K, string>;
  const categoryIds = ids(Object.keys(CATEGORIES) as (keyof typeof CATEGORIES)[]);
  const stationIds = ids(Object.keys(STATIONS) as (keyof typeof STATIONS)[]);
  const sectionIds = ids(Object.keys(SECTIONS) as (keyof typeof SECTIONS)[]);
  const catalogId = id();

  const categories = Object.entries(CATEGORIES).map(([k, name], position) => ({
    id: categoryIds[k as keyof typeof CATEGORIES], org_id: orgId, name: name[locale], position, created_at: createdAt,
  }));
  const stations = Object.entries(STATIONS).map(([k, name], position) => ({
    id: stationIds[k as keyof typeof STATIONS], org_id: orgId, name: name[locale], position, created_at: createdAt,
  }));
  const sections = Object.entries(SECTIONS).map(([k, name], position) => ({
    id: sectionIds[k as keyof typeof SECTIONS], org_id: orgId, catalog_id: catalogId, name: name[locale], position,
  }));

  const products: Record<string, unknown>[] = [];
  const variants: Record<string, unknown>[] = [];
  const entries: Record<string, unknown>[] = [];
  const positionInSection: Record<string, number> = {};
  for (const p of PRODUCTS) {
    const productId = id();
    products.push({
      id: productId, org_id: orgId, category_id: categoryIds[p.category], prep_station_id: p.station ? stationIds[p.station] : null,
      name: p.name[locale], vat_rate_bp: p.vatRateBp, created_at: createdAt,
    });
    p.variants.forEach((v, position) => {
      const variantId = id();
      variants.push({ id: variantId, org_id: orgId, product_id: productId, name: v.name ? v.name[locale] : '', code: null, position, created_at: createdAt });
      const at = (positionInSection[p.section] = (positionInSection[p.section] ?? -1) + 1);
      entries.push({
        id: id(), org_id: orgId, catalog_id: catalogId, section_id: sectionIds[p.section], variant_id: variantId, price_cents: v.priceCents,
        visible: 1, position: at, quick_quantities: v.quick ? JSON.stringify(v.quick) : null,
      });
    });
  }
  const catalog = { id: catalogId, org_id: orgId, name: CATALOG_NAME[locale], is_default: 1, created_at: createdAt, updated_at: createdAt };
  return { categories, stations, products, variants, catalog, sections, entries };
}

export type ExampleMenu = ReturnType<typeof exampleMenuRows>;

// Its INSERTs, each only when `where` holds (e.g. "the org row went in").
export function exampleMenuStatements(db: D1Database, menu: ExampleMenu, where: { sql: string; params: unknown[] }): D1PreparedStatement[] {
  return present([
    jsonRowsStatement(db, 'categories', ['id', 'org_id', 'name', 'position', 'created_at'], menu.categories, { where }),
    jsonRowsStatement(db, 'prep_stations', ['id', 'org_id', 'name', 'position', 'created_at'], menu.stations, { where }),
    jsonRowsStatement(db, 'products', ['id', 'org_id', 'category_id', 'prep_station_id', 'name', 'vat_rate_bp', 'created_at'], menu.products, { where }),
    jsonRowsStatement(db, 'product_variants', ['id', 'org_id', 'product_id', 'name', 'code', 'position', 'created_at'], menu.variants, { where }),
    jsonRowsStatement(db, 'catalogs', ['id', 'org_id', 'name', 'is_default', 'created_at', 'updated_at'], [menu.catalog], { where }),
    jsonRowsStatement(db, 'catalog_sections', ['id', 'org_id', 'catalog_id', 'name', 'position'], menu.sections, { where }),
    jsonRowsStatement(
      db,
      'catalog_entries',
      ['id', 'org_id', 'catalog_id', 'section_id', 'variant_id', 'price_cents', 'visible', 'position', 'quick_quantities'],
      menu.entries,
      { where }
    ),
  ]);
}
