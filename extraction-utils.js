export const PRODUCT_PRICE_LABELS = [
  'Bruttó termék ár',
  'Brutto termek ar',
  'Termék ár',
  'Termek ar',
  'Termék ára',
  'Termek ara',
  'Bruttó ár',
  'Brutto ar',
  'Nettó ár',
  'Netto ar',
  'Akciós ár',
  'Akcios ar',
  'Eladási ár',
  'Eladasi ar',
  'Fogyasztói ár',
  'Fogyasztoi ar',
  'Megrendelés szerelés nélkül',
  'Megrendeles szereles nelkul',
  'Ár szerelés nélkül',
  'Ar szereles nelkul',
];

export const SERVICE_PRICE_LABELS = [
  'Kiszállási díj',
  'Kiszallasi dij',
  'Szervíz',
  'Szerviz',
  'Szerviz díj',
  'Szerviz dij',
  'Munkadíj',
  'Munkadij',
  'Óradíj',
  'Oradij',
  'Telepítési díj',
  'Telepitesi dij',
  'Telepítés díja',
  'Telepites dija',
  'Szerelési díj',
  'Szerelesi dij',
  'Tisztítás díja',
  'Tisztitas dija',
  'Karbantartási díj',
  'Karbantartasi dij',
];

export const KNOWN_SERIES = [
  'Therma V',
  'Xtreme Save',
  'Breezeless E',
  'All Easy Pro',
  'Gaia',
  'WINNER',
  'SILENCE',
  'Next',
  'M-Thermal',
];

export function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function stripHtml(value) {
  return cleanText(String(value || '').replace(/<[^>]*>/g, ' '));
}

export function foldText(value) {
  return cleanText(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function firstNonEmpty(...values) {
  return values.map(cleanText).find(Boolean) || '';
}

export function truncate(value, max = 2000) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function cleanProductName(value) {
  return stripHtml(value)
    .replace(/^kl[íi]maszerel[ée]sek\s*\|\|\s*/i, '')
    .replace(/\s*[-–|:]\s*term[ée]k\s+r[ée]szletek\s*$/i, '')
    .replace(/\s*[-–|:]\s*product\s+details\s*$/i, '')
    .trim();
}

export function parsePriceText(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (/ár\s*kérésre|price\s*on\s*request|request\s*a\s*price/i.test(text)) return 'Ár kérésre';
  const amount = String.raw`(?:\d{1,3}(?:[\s.,]\d{3})+(?:[.,]\d+)?|\d{2,}(?:[.,]\d+)?)`;
  const currency = String.raw`(?:Ft|HUF|EUR|€|USD|\$)`;
  const match = text.match(new RegExp(`(?:${amount}\\s*${currency}|${currency}\\s*${amount})`, 'i'));
  return match ? cleanText(match[0]) : null;
}

export function normalizeVatStatus(value, fallback = 'ismeretlen') {
  const text = foldText(value);
  if (['brutto', 'bruttó', 'gross'].includes(text)) return 'bruttó';
  if (['netto', 'nettó', 'net'].includes(text)) return 'nettó';
  if (['ismeretlen', 'unknown', ''].includes(text)) return fallback;
  return fallback;
}

export function inferPriceVatStatus(value) {
  const text = foldText(value);
  if (!text) return 'ismeretlen';
  const amount = String.raw`\d{1,3}(?:[\s.,]\d{3})+(?:[.,]\d+)?|\d{2,}(?:[.,]\d+)?`;
  const grossWithNetInParentheses = new RegExp(`(?:${amount})\\s*(?:ft|huf|eur|€)\\s*\\([^)]*(?:${amount})\\s*(?:ft|huf|eur|€)?\\s*\\+\\s*afa`, 'i');
  if (grossWithNetInParentheses.test(text)) return 'bruttó';
  if (/(netto|net price|vat excluded|tax excluded|excl\.?\s*vat|afa nelkul|plusz afa|\+\s*afa|nem tartalmazza\s+az\s+afa-?t)/i.test(text)) {
    return 'nettó';
  }
  if (/(brutto|gross|vat included|tax included|incl\.?\s*vat|afa[- ]?val|afa-?t\s+tartalmaz|afat tartalmaz|afa tartalommal|tartalmazza\s+az\s+afa-?t|tartalmazzak\s+az\s+afa-?t)/i.test(text)) {
    return 'bruttó';
  }
  return 'ismeretlen';
}

export function knownVatStatus(value) {
  const status = inferPriceVatStatus(value);
  return status === 'ismeretlen' ? null : status;
}

export function priceInfo(price, context = '') {
  if (!price) return null;
  return {
    price,
    price_vat_status: inferPriceVatStatus(context || price),
  };
}

export function extractPriceInfoFromText(text) {
  const price = parsePriceText(text);
  return priceInfo(price, text);
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractPriceInfoNearLabels(text, labels) {
  const clean = cleanText(text);
  for (const label of labels) {
    const labelPattern = escapeRegExp(label).replace(/\s+/g, '\\s+');
    const regex = new RegExp(`${labelPattern}.{0,120}?((?:\\d{1,3}(?:[\\s.,]\\d{3})+(?:[.,]\\d+)?|\\d{2,}(?:[.,]\\d+)?)\\s*(?:Ft|HUF|EUR|€|USD|\\$)|(?:Ft|HUF|EUR|€|USD|\\$)\\s*(?:\\d{1,3}(?:[\\s.,]\\d{3})+(?:[.,]\\d+)?|\\d{2,}(?:[.,]\\d+)?))`, 'i');
    const match = clean.match(regex);
    if (match) {
      const start = match.index ?? 0;
      const context = clean.slice(start, start + match[0].length + 80);
      return priceInfo(parsePriceText(match[1]), `${label} ${context}`);
    }
  }
  return null;
}

export function extractPriceNearLabels(text, labels) {
  return extractPriceInfoNearLabels(text, labels)?.price || null;
}

export function propertyKeyMatchesPriceLabel(key, labels) {
  const foldedKey = foldText(key);
  return labels.some((label) => {
    const foldedLabel = foldText(label);
    return foldedLabel.length > 2 && foldedKey.includes(foldedLabel);
  });
}

export function extractPriceInfoFromProperties(properties, labels, allowAnyPrice = false) {
  for (const [key, value] of Object.entries(properties || {})) {
    if (propertyKeyMatchesPriceLabel(key, labels)) {
      const parsed = parsePriceText(value) || parsePriceText(`${key} ${value}`);
      if (parsed) return priceInfo(parsed, `${key} ${value}`);
    }
  }

  if (!allowAnyPrice) return null;
  for (const value of Object.values(properties || {})) {
    const parsed = parsePriceText(value);
    if (parsed) return priceInfo(parsed, value);
  }
  return null;
}

export function inferWooProductVatStatusFromApi(product) {
  const contexts = [
    product?.price_html,
    product?.prices?.price_html,
    product?.short_description,
    product?.description,
    product?.add_to_cart?.description,
    product?.summary,
    product?.name,
  ];
  for (const context of contexts) {
    const status = knownVatStatus(stripHtml(context));
    if (status) return status;
  }
  return null;
}

export function getGroupKey(name) {
  const cleanName = cleanText(name);
  if (!cleanName) return null;

  const brand = cleanName.split(/\s+/)[0].toUpperCase();
  const series = KNOWN_SERIES.find((item) => cleanName.toLowerCase().includes(item.toLowerCase()));
  if (!series) return null;

  const lower = cleanName.toLowerCase();
  let productType = 'other';
  if (lower.includes('monoblokk') || lower.includes('monoblokkos')) productType = 'monoblokk';
  else if (lower.includes('split')) productType = 'split';
  else if (lower.includes('hőszivattyú')) productType = 'hőszivattyú';

  return `${brand}|${series}|${productType}`;
}

export function resolveCanonical(product, canonicalByGroup) {
  const groupKey = getGroupKey(product?.name);
  if (!groupKey || !canonicalByGroup) return null;

  if (!canonicalByGroup.has(groupKey)) {
    canonicalByGroup.set(groupKey, {
      url: product.url || '',
      name: product.name,
    });
  }

  const canonical = canonicalByGroup.get(groupKey);
  return {
    groupKey,
    isCanonical: canonical.url === (product.url || '') && canonical.name === product.name,
    canonicalUrl: canonical.url,
    canonicalName: canonical.name,
  };
}
