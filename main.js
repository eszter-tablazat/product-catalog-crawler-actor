import { gotScraping } from 'got-scraping';
import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';
import * as cheerio from 'cheerio';
import { gunzipSync } from 'node:zlib';
import {
  PRODUCT_PRICE_LABELS,
  SERVICE_PRICE_LABELS,
  cleanProductName,
  cleanText,
  extractPriceInfoFromProperties,
  extractPriceInfoFromText,
  extractPriceInfoNearLabels,
  firstNonEmpty,
  inferPriceVatStatus,
  inferWooProductVatStatusFromApi,
  knownVatStatus,
  normalizeVatStatus,
  parsePriceText,
  priceInfo,
  resolveCanonical,
  stripHtml,
  truncate,
  unique,
} from './extraction-utils.js';

const DEFAULTS = {
  maxProducts: 5000,
  maxPages: 1000,
  maxConcurrency: 1,
  maxRequestsPerMinute: 30,
  sameDomainDelaySecs: 2,
  maxRequestRetries: 8,
  proxyMode: 'auto',
  proxyCountry: 'HU',
  includeVariants: true,
  includeServices: true,
  useBrowserFallback: false,
  generatedProductIdLimit: 300,
  defaultVatStatus: 'ismeretlen',
  enableCanonicalGrouping: true,
  webhookUrl: '',
  webhookApiKey: '',
  webhookHeaderName: 'Authorization',
  webhookAuthPrefix: 'Bearer',
  webhookBatchSize: 100,
  webhookFailOnError: false,
  companyId: '',
  jobId: '',
};

const PRODUCT_URL_HINTS = [
  '/termek/',
  '/termek_',
  '/product/',
  '/products/',
  '/p/',
  '/item/',
  '/sku/',
  '/modell/',
  '/model/',
  '/shop_artdet.php',
  '/catalog/product/view',
  'route=product/product',
  'controller=product',
  '/detail/',
  '/details/',
  '/adatlap/',
  '/product_info.php',
  '/product_details.php',
  '/product_detail.php',
  '/termekadatlap',
];

const CATEGORY_URL_HINTS = [
  '/termekek/',
  '/termekkategoria/',
  '/termek-kategoria/',
  '/termek-katalogus/',
  '/category/',
  '/categories/',
  '/kategoria/',
  '/kinalat/',
  '/ajanlat/',
  '/catalog/',
  '/catalogue/',
  '/katalogus/',
  '/katalog/',
  '/shop/',
  '/webshop/',
  '/aruhaz/',
  '/collections/',
  '/shop_cat.php',
  '/shop_list.php',
  'route=product/category',
];

const SERVICE_URL_HINTS = [
  '/klima-szereles',
  '/klima-javitas',
  '/klima-tisztitas',
  '/hutokamra-telepites',
  '/hoszivattyu-telepites',
  '/hutoszerviz',
  '/karbantartas',
  '/telepites',
  '/szereles',
  '/javitas',
  '/tisztitas',
  '/garancia',
  '/service/',
  '/services/',
  '/szolgaltatas/',
  '/szolgáltatás/',
];

const BAD_URL_HINTS = [
  '/attachment/',
  '/wp-content/uploads/',
  '/blog',
  '/hirek',
  '/news',
  '/referencia',
  '/referenciak',
  '/referenciák',
  '/referenci%C3%A1k',
  '/allas',
  '/karrier',
  '/career',
  '/rolunk',
  '/rólunk',
  '/r%C3%B3lunk',
  '/about',
  '/megoldasok',
  '/megoldások',
  '/megold%C3%A1sok',
  '/solutions',
  '/contact',
  '/kapcsolat',
  '/cart',
  '/kosar',
  '/checkout',
  '/penztar',
  '/account',
  '/login',
  '/privacy',
  '/adatvedelem',
  '/aszf',
  '/terms',
  '/wp-content',
  '/wp-admin',
];

const PRODUCT_TEXT_SIGNALS = [
  'kosar',
  'cart',
  'ajanlat',
  'quote',
  'sku',
  'cikkszam',
  'cikkszám',
  'article number',
  'item number',
  'model',
  'modell',
  'termek',
  'termék',
  'product',
  'price',
  'ar',
  'ár',
  'műszaki adatok',
  'muszaki adatok',
  'technical data',
  'specification',
  'specifikáció',
  'tulajdonságok',
  'jellemzők',
  'paraméterek',
  'parameterek',
  'adatlap',
  'katalógus',
  'catalog',
  'download',
  'letöltés',
  'brochure',
];

const SERVICE_TEXT_SIGNALS = [
  'szolgáltatás',
  'szolgaltatas',
  'telepítés',
  'telepites',
  'szerelés',
  'szereles',
  'javítás',
  'javitas',
  'tisztítás',
  'tisztitas',
  'karbantartás',
  'karbantartas',
  'beüzemelés',
  'beuzemeles',
  'garancia',
  'kiszállási díj',
  'kiszallasi dij',
  'munkadíj',
  'munkadij',
  'helyszíni felmérés',
  'helyszini felmeres',
];

const PRODUCT_CONTAINER_SELECTORS = [
  '[itemscope][itemtype*="Product"]',
  '.product-detail',
  '.product_details',
  '.product-info',
  '.product-page',
  '.product-view',
  '.product-single',
  '.product-main',
  '.product__info',
  '.product-info-main',
  '.catalog-product-view',
  '#product',
  '#product_info',
  '#product_details',
  '[class*="product-detail"]',
  '[class*="product_detail"]',
];

const LISTING_CARD_SELECTORS = [
  '.product-card',
  '.product-item',
  '.product-list-item',
  '.product-grid-item',
  '.card-product',
  '.collection-product',
  '.catalog-product',
  '.product-box',
  '.termek',
  '[class*="product-card"]',
  '[class*="product_item"]',
  '[class*="product-item"]',
  '[class*="product-box"]',
  '[class*="termek"]',
  '[data-product-id]',
  '[data-product]',
];

const PROPERTY_BLOCK_SELECTORS = [
  '.specifications',
  '.specification',
  '.specs',
  '.parameters',
  '.params',
  '.attributes',
  '.product-attributes',
  '.woocommerce-product-attributes',
  '.technical-data',
  '.tech-data',
  '.product-specs',
  '.product_properties',
  '.product-properties',
  '.product-param',
  '.product-params',
  '.adatlap',
  '.muszaki-adatok',
  '.tulajdonsagok',
  '[class*="spec"]',
  '[class*="param"]',
  '[class*="attribute"]',
  '[class*="tulajdons"]',
];

const MEDIA_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.css',
  '.js',
  '.pdf',
  '.zip',
  '.mp4',
  '.webm',
];

await Actor.init();

const input = {
  ...DEFAULTS,
  ...(await Actor.getInput()),
};

if (!input.firecrawlApiKey && process.env.FIRECRAWL_API_KEY) {
  input.firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
}

input.webhookUrl = input.webhookUrl || process.env.OUTPUT_WEBHOOK_URL || '';
input.webhookApiKey = input.webhookApiKey || process.env.OUTPUT_WEBHOOK_API_KEY || process.env.WEBHOOK_API_KEY || '';
input.webhookHeaderName = input.webhookHeaderName || process.env.OUTPUT_WEBHOOK_HEADER_NAME || 'Authorization';
input.webhookAuthPrefix = input.webhookAuthPrefix ?? process.env.OUTPUT_WEBHOOK_AUTH_PREFIX ?? 'Bearer';
input.webhookBatchSize = Number(input.webhookBatchSize || process.env.OUTPUT_WEBHOOK_BATCH_SIZE || 100);
input.webhookFailOnError = asBool(input.webhookFailOnError || process.env.OUTPUT_WEBHOOK_FAIL_ON_ERROR);
input.defaultVatStatus = normalizeVatStatus(
  input.defaultVatStatus || process.env.DEFAULT_VAT_STATUS || 'ismeretlen',
  'ismeretlen',
);
input.maxConcurrency = boundedInteger(input.maxConcurrency, 1, 1, 20);
input.maxRequestsPerMinute = boundedInteger(input.maxRequestsPerMinute, 30, 1, 600);
input.sameDomainDelaySecs = boundedInteger(input.sameDomainDelaySecs, 2, 0, 120);
input.maxRequestRetries = boundedInteger(input.maxRequestRetries, 8, 0, 20);
input.proxyMode = String(process.env.PROXY_MODE || input.proxyMode || 'auto').trim().toLowerCase();
if (!['none', 'auto', 'residential'].includes(input.proxyMode)) input.proxyMode = 'auto';
input.proxyCountry = String(process.env.PROXY_COUNTRY || input.proxyCountry || 'HU').trim().toUpperCase();

if (!input.startUrl) {
  throw new Error('Missing required input.startUrl');
}

const startUrl = normalizeUrl(input.startUrl);
const origin = new URL(startUrl).origin;
const targetHost = hostKey(startUrl);
// Multilingual sites (e.g. /hu, /hu/hu/start): stay inside the start URL's language
// path, otherwise the crawl wanders into /de, /fr ... versions of the same catalog.
const scopePrefix = input.restrictToLocalePath === false ? '' : localePathPrefix(startUrl);
const seenProducts = new Set();
const canonicalByGroup = new Map();
let productCount = 0;
let pageCount = 0;
let nextTargetFetchAt = 0;
let adaptiveDelayMs = 0;
const ADAPTIVE_MAX_DELAY_MS = 30000;
let targetDirectFetchBlocked = false;
let sharedProxyConfiguration;
let proxyConfigurationResolved = false;
let webhookBatchIndex = 0;
let webhookDeliveredProducts = 0;
let webhookFailedBatches = 0;
const webhookBuffer = [];
const summary = {
  startUrl,
  strategy: null,
  stoppedReason: null,
  productCount: 0,
  pageCount: 0,
  datasetId: process.env.APIFY_DEFAULT_DATASET_ID || null,
  actorRunId: process.env.APIFY_ACTOR_RUN_ID || null,
  companyId: input.companyId || null,
  jobId: input.jobId || null,
  crawlerThrottle: {
    maxConcurrency: input.maxConcurrency,
    maxRequestsPerMinute: input.maxRequestsPerMinute,
    sameDomainDelaySecs: input.sameDomainDelaySecs,
    maxRequestRetries: input.maxRequestRetries,
  },
  proxy: {
    mode: input.proxyMode,
    country: input.proxyMode === 'residential' ? input.proxyCountry : null,
  },
  scopePrefix: scopePrefix || null,
  webhook: {
    enabled: Boolean(input.webhookUrl),
    deliveredProducts: 0,
    failedBatches: 0,
  },
  warnings: [],
};

try {
  const feed = await tryXmlProductFeed(startUrl, input);
  if (feed.handled) {
    summary.strategy = 'xml_product_feed';
  } else {
    const woo = await tryWooCommerce(origin, input);
    if (woo.handled) {
      summary.strategy = 'woocommerce_store_api';
    } else {
      const shopify = await tryShopify(origin, input);
      if (shopify.handled) {
        summary.strategy = 'shopify_products_json';
      } else {
        summary.strategy = 'html_crawl';
        await crawlHtmlFallback(input);
      }
    }
  }

  summary.productCount = productCount;
  summary.pageCount = pageCount;
  await flushWebhookBatch(true);
  summary.webhook.deliveredProducts = webhookDeliveredProducts;
  summary.webhook.failedBatches = webhookFailedBatches;
  await Actor.setValue('SUMMARY', summary);
} finally {
  await Actor.exit();
}

function normalizeUrl(value) {
  const url = new URL(String(value).trim());
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || key === 'fcid' || ['fbclid', 'gclid', 'yclid'].includes(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString().replace(/\/$/, '');
}

function hostKey(value) {
  const host = new URL(value).hostname.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

function sameDomain(value) {
  try {
    const host = hostKey(value);
    return host === targetHost || host.endsWith(`.${targetHost}`);
  } catch {
    return false;
  }
}

function localePathPrefix(value) {
  try {
    const segments = new URL(value).pathname.split('/').filter(Boolean);
    const locale = [];
    for (const segment of segments) {
      if (!/^[a-z]{2}(?:[-_][a-z]{2,4})?$/i.test(segment)) break;
      locale.push(segment.toLowerCase());
    }
    return locale.length ? `/${locale.join('/')}` : '';
  } catch {
    return '';
  }
}

function inScope(value) {
  if (!scopePrefix) return true;
  try {
    const path = new URL(value).pathname.toLowerCase().replace(/\/$/, '');
    return path === scopePrefix || path.startsWith(`${scopePrefix}/`);
  } catch {
    return false;
  }
}

function shouldSkipUrl(value) {
  const lower = decodeURIComponent(String(value)).toLowerCase();
  if (!sameDomain(value)) return true;
  if (!inScope(value)) return true;
  if (BAD_URL_HINTS.some((hint) => lower.includes(hint))) return true;
  if (MEDIA_EXTENSIONS.some((ext) => lower.split('?')[0].endsWith(ext) || lower.endsWith(ext))) return true;
  if (/_img\.php|\/image\.php|\/thumb(?:nail)?\.php/.test(lower)) return true;
  return false;
}

function isServiceUrl(value) {
  const lower = decodeURIComponent(String(value || '')).toLowerCase();
  return SERVICE_URL_HINTS.some((hint) => lower.includes(hint));
}

function scoreUrl(value) {
  const lower = decodeURIComponent(String(value)).toLowerCase();
  let score = 0;
  if (PRODUCT_URL_HINTS.some((hint) => lower.includes(hint))) score += 100;
  if (input.includeServices && isServiceUrl(value)) score += 80;
  if (CATEGORY_URL_HINTS.some((hint) => lower.includes(hint))) score += 50;
  if (/\/(?:[^/]+-)?(?:termek|product|modell|model|adatlap|catalog|katalogus)[^/]*$/i.test(lower)) score += 35;
  if (/\/[^/]*\d[^/]*(?:\/)?$/.test(lower)) score += 10;
  if (BAD_URL_HINTS.some((hint) => lower.includes(hint))) score -= 1000;
  return score;
}

function isLikelyXml(text) {
  const head = String(text || '').slice(0, 500).trim().toLowerCase();
  return head.startsWith('<?xml') || head.startsWith('<rss') || head.startsWith('<feed') || head.startsWith('<urlset') || head.startsWith('<sitemapindex');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Adaptive politeness: start fast, slow down when the target signals rate limiting.

function registerTargetThrottleSignal(url, statusCode) {
  if (![429, 503].includes(Number(statusCode))) return;
  try {
    if (hostKey(url) !== targetHost) return;
  } catch {
    return;
  }
  const previous = Math.max(input.sameDomainDelaySecs * 1000, adaptiveDelayMs);
  adaptiveDelayMs = Math.min(ADAPTIVE_MAX_DELAY_MS, Math.max(5000, previous * 2));
  const warning = `HTTP ${statusCode} from target; slowing down to ${Math.round(adaptiveDelayMs / 1000)}s between requests`;
  if (!summary.warnings.includes(warning)) summary.warnings.push(warning);
  log.warning(warning, { url });
}

async function paceTargetRequest(url) {
  try {
    if (hostKey(url) !== targetHost) return;
  } catch {
    return;
  }

  const delayMs = Math.max(input.sameDomainDelaySecs * 1000, adaptiveDelayMs);
  if (delayMs <= 0) return;

  const scheduledAt = Math.max(Date.now(), nextTargetFetchAt);
  nextTargetFetchAt = scheduledAt + delayMs;
  const waitMs = scheduledAt - Date.now();
  if (waitMs > 0) await wait(waitMs);
}

async function fetchWithPacing(url, init) {
  const isTargetRequest = sameDomain(url);
  if (isTargetRequest && targetDirectFetchBlocked) return null;

  await paceTargetRequest(url);
  const proxyConfiguration = isTargetRequest ? await getProxyConfiguration(input) : null;
  const response = proxyConfiguration
    ? await fetchViaProxy(url, init, proxyConfiguration)
    : await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  if (response.status === 429 && isTargetRequest) {
    targetDirectFetchBlocked = true;
    const warning = `HTTP 429 during direct discovery: ${url}; switching to proxy crawler`;
    summary.warnings.push(warning);
    log.warning(warning);
  }
  return response;
}

// Discovery requests (feeds, sitemaps, Woo/Shopify APIs) to the target domain go
// through the same Apify Proxy as the HTML crawler. Direct datacenter requests were
// rejected by some sites (e.g. nilan.hu: "fetch failed").
async function fetchViaProxy(url, init = {}, proxyConfiguration) {
  const proxyUrl = await proxyConfiguration.newUrl();
  const res = await gotScraping({
    url,
    method: init.method || 'GET',
    headers: init.headers,
    body: init.body,
    proxyUrl,
    throwHttpErrors: false,
    followRedirect: true,
    timeout: { request: 30000 },
    retry: { limit: 1 },
    responseType: 'buffer',
  });
  const raw = Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body ?? ''));
  const body = raw.toString('utf8');
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    headers: res.headers,
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => raw,
  };
}

async function getProxyConfiguration(options) {
  if (proxyConfigurationResolved) return sharedProxyConfiguration;
  proxyConfigurationResolved = true;
  if (options.proxyMode === 'none') {
    sharedProxyConfiguration = undefined;
    return sharedProxyConfiguration;
  }
  const proxyOptions = options.proxyMode === 'residential'
    ? { groups: ['RESIDENTIAL'], countryCode: options.proxyCountry }
    : { useApifyProxy: true };
  sharedProxyConfiguration = await Actor.createProxyConfiguration(proxyOptions);
  if (!sharedProxyConfiguration) {
    throw new Error(`Apify proxy is not available for proxyMode=${options.proxyMode}`);
  }
  return sharedProxyConfiguration;
}

async function fetchText(url, options = {}) {
  try {
    const response = await fetchWithPacing(url, {
      headers: {
        accept: options.accept || 'text/html,application/xhtml+xml,application/xml,text/xml,*/*',
        'user-agent': 'ProductCatalogCrawler/1.0 (+https://apify.com)',
      },
    });
    if (!response?.ok) return null;
    return response.text();
  } catch (error) {
    summary.warnings.push(`Fetch failed: ${url} - ${error.message}`);
    return null;
  }
}

function extractStructuredPrice($) {
  const amount = firstNonEmpty(
    $('[itemprop="price"]').first().attr('content'),
    $('[property="product:price:amount"]').first().attr('content'),
    $('[name="twitter:data1"]').first().attr('content'),
  );
  const currency = firstNonEmpty(
    $('[itemprop="priceCurrency"]').first().attr('content'),
    $('[property="product:price:currency"]').first().attr('content'),
  );
  if (amount && currency) return parsePriceText(`${amount} ${currency}`);
  return parsePriceText(amount);
}

function extractDomPriceInfo($, properties, isServiceRecord) {
  const labels = isServiceRecord
    ? [...SERVICE_PRICE_LABELS, ...PRODUCT_PRICE_LABELS]
    : PRODUCT_PRICE_LABELS;
  const fromBody = extractPriceInfoNearLabels($('body').text(), labels);
  if (fromBody) return fromBody;

  const fromProperties = extractPriceInfoFromProperties(properties, labels, isServiceRecord);
  if (fromProperties) return fromProperties;

  const directText = firstNonEmpty(
    $('.price, .ar, .termek-ar, .product-ar, .product-price, .woocommerce-Price-amount, [class*="price"], [class*="Price"]').first().text(),
    $('[itemprop="price"]').first().parent().text(),
  );
  const directInfo = extractPriceInfoFromText(directText);
  if (directInfo) return directInfo;

  const structured = extractStructuredPrice($);
  if (structured) return priceInfo(structured);

  const productScopeText = $('[itemscope][itemtype*="Product"]').first().text();
  return extractPriceInfoFromText(productScopeText);
}

function priceFromWoo(prices) {
  if (!prices) return null;
  const raw = prices.price || prices.sale_price || prices.regular_price;
  if (!raw) return null;
  const currency = prices.currency_code || '';
  const minorUnit = Number.isInteger(prices.currency_minor_unit) ? prices.currency_minor_unit : 0;
  const numeric = Number(raw) / (10 ** minorUnit);
  if (!Number.isFinite(numeric)) return `${raw}${currency ? ` ${currency}` : ''}`;
  return `${numeric}${currency ? ` ${currency}` : ''}`;
}

async function fetchJson(url) {
  try {
    const response = await fetchWithPacing(url, {
      headers: {
        accept: 'application/json,text/plain,*/*',
        'user-agent': 'ProductCatalogCrawler/1.0 (+https://apify.com)',
      },
    });
    if (!response?.ok) return null;
    const text = await response.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'yes', 'y'].includes(String(value || '').trim().toLowerCase());
}

function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.floor(numeric), minimum), maximum);
}

function webhookHeaders() {
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'ProductCatalogCrawler/1.1 (+https://apify.com)',
  };
  if (input.webhookApiKey) {
    const headerName = input.webhookHeaderName || 'Authorization';
    const prefix = input.webhookAuthPrefix === null || input.webhookAuthPrefix === undefined
      ? 'Bearer'
      : String(input.webhookAuthPrefix).trim();
    headers[headerName] = headerName.toLowerCase() === 'authorization' && prefix
      ? `${prefix} ${input.webhookApiKey}`
      : input.webhookApiKey;
  }
  return headers;
}

function webhookPayload(products, isFinal = false) {
  return {
    event: isFinal ? 'products.final_batch' : 'products.batch',
    job: {
      runId: process.env.APIFY_ACTOR_RUN_ID || null,
      actorId: process.env.APIFY_ACTOR_ID || null,
      sourceUrl: startUrl,
      companyId: input.companyId || null,
      jobId: input.jobId || null,
    },
    batch: {
      index: webhookBatchIndex,
      count: products.length,
      totalSoFar: productCount,
      isFinal,
    },
    products,
  };
}

async function postWebhook(payload) {
  if (!input.webhookUrl) return true;
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input.webhookUrl, {
        method: 'POST',
        headers: webhookHeaders(),
        body: JSON.stringify(payload),
      });
      if (response.ok) return true;
      const text = await response.text().catch(() => '');
      lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }

  webhookFailedBatches += 1;
  const message = `Webhook batch ${payload.batch?.index} failed: ${lastError?.message || 'unknown error'}`;
  summary.warnings.push(message);
  if (input.webhookFailOnError) throw new Error(message);
  return false;
}

async function enqueueWebhookProduct(product) {
  if (!input.webhookUrl) return;
  webhookBuffer.push(product);
  const batchSize = Number.isFinite(input.webhookBatchSize) && input.webhookBatchSize > 0
    ? Math.min(Math.floor(input.webhookBatchSize), 1000)
    : 100;
  if (webhookBuffer.length >= batchSize) {
    await flushWebhookBatch(false);
  }
}

async function flushWebhookBatch(isFinal = false) {
  if (!input.webhookUrl) return;
  if (!webhookBuffer.length && !isFinal) return;
  const products = webhookBuffer.splice(0, webhookBuffer.length);
  webhookBatchIndex += 1;
  const sent = await postWebhook(webhookPayload(products, isFinal));
  if (sent) webhookDeliveredProducts += products.length;
}

function readXmlText($xml, element, names) {
  for (const name of names) {
    const value = cleanText($xml(element).children(name).first().text() || $xml(element).find(name).first().text());
    if (value) return value;
  }
  return '';
}

function readXmlAttr($xml, element, names, attr) {
  for (const name of names) {
    const value = cleanText($xml(element).children(name).first().attr(attr) || $xml(element).find(name).first().attr(attr));
    if (value) return value;
  }
  return '';
}

function readXmlFirstText($xml, element, names) {
  for (const name of names) {
    const value = readXmlText($xml, element, [name]);
    if (value) return { name, value };
  }
  return null;
}

function xmlProductFromElement($xml, element, sourceUrl) {
  const name = firstNonEmpty(
    readXmlText($xml, element, ['title', 'name', 'g\\:title', 'product_name', 'productname', 'megnevezes']),
    $xml(element).attr('name'),
  );
  if (!name) return null;

  const link = firstNonEmpty(
    readXmlText($xml, element, ['link', 'g\\:link', 'url', 'product_url', 'producturl']),
    readXmlAttr($xml, element, ['link'], 'href'),
    sourceUrl,
  );
  const rawImage = firstNonEmpty(
    readXmlText($xml, element, ['g\\:image_link', 'image_link', 'image', 'image_url', 'picture', 'picture_url', 'img']),
    readXmlAttr($xml, element, ['media\\:content', 'enclosure'], 'url'),
  );
  const priceMatch = readXmlFirstText($xml, element, ['gross_price', 'brutto_price', 'brutto_ar', 'net_price', 'netto_price', 'netto_ar', 'g\\:price', 'price', 'ar', 'sale_price']);
  const price = priceMatch?.value || '';
  const sku = firstNonEmpty(
    readXmlText($xml, element, ['g\\:id', 'id', 'sku', 'cikkszam', 'item_group_id', 'product_id']),
  );
  const category = firstNonEmpty(
    readXmlText($xml, element, ['g\\:product_type', 'product_type', 'category', 'kategoria']),
  );

  const properties = {};
  $xml(element).children().each((_i, child) => {
    const key = cleanText(child.tagName || child.name);
    const value = cleanText($xml(child).text());
    if (key && value && key.length <= 80 && value.length <= 500 && !['title', 'name', 'description', 'link'].includes(key.toLowerCase())) {
      properties[key.replace(/^g:/, '')] = value;
    }
  });

  return {
    source: 'xml_feed',
    sourceType: 'product',
    id: sku || null,
    parentId: null,
    name: cleanProductName(name),
    url: link ? new URL(link, sourceUrl).toString() : sourceUrl,
    sku: sku || null,
    price: price || null,
    price_vat_status: priceMatch ? inferPriceVatStatus(`${priceMatch.name} ${priceMatch.value}`) : 'ismeretlen',
    currency: null,
    category: category || null,
    description: truncate(readXmlText($xml, element, ['description', 'g\\:description', 'short_description', 'desc']), 3000),
    images: rawImage ? [new URL(rawImage, sourceUrl).toString()] : [],
    properties,
    variants: [],
  };
}

async function tryXmlProductFeed(url, options) {
  const text = await fetchText(url, { accept: 'application/xml,text/xml,application/rss+xml,application/atom+xml,*/*' });
  if (!text || !isLikelyXml(text)) return { handled: false };

  const $xml = cheerio.load(text, { xmlMode: true });
  const candidates = [];
  $xml('item, entry, product, termek').each((_i, el) => {
    const product = xmlProductFromElement($xml, el, url);
    if (product) candidates.push(product);
  });

  if (!candidates.length) return { handled: false };
  log.info(`XML product feed detected with ${candidates.length} product-like items`);
  for (const product of candidates) {
    await pushProduct(product);
    if (productCount >= options.maxProducts) break;
  }
  return { handled: productCount > 0 };
}

async function detectWooCommerceVatStatus(baseUrl, sampleProduct, options) {
  const fromApi = inferWooProductVatStatusFromApi(sampleProduct);
  if (fromApi) return fromApi;

  const sampleUrls = unique([sampleProduct?.permalink, baseUrl]);
  for (const url of sampleUrls) {
    const html = await fetchText(url);
    if (!html) continue;
    const $ = cheerio.load(html);
    const focusedText = firstNonEmpty(
      $('.woocommerce-price-suffix, .price, .summary, .product, [class*="tax"], [class*="vat"], [class*="afa"]').text(),
      $('body').text(),
    );
    const status = knownVatStatus(focusedText);
    if (status) return status;
  }

  return options.defaultVatStatus || 'ismeretlen';
}

function normalizeWooProduct(product, sourceType = 'product', priceVatStatus = 'ismeretlen') {
  const properties = {};
  if (product.sku) properties.sku = String(product.sku);
  if (product.weight) properties.weight = String(product.weight);
  if (product.formatted_dimensions && product.formatted_dimensions !== 'N/A') {
    properties.dimensions = String(product.formatted_dimensions);
  } else if (product.dimensions) {
    const dims = [product.dimensions.length, product.dimensions.width, product.dimensions.height].filter(Boolean);
    if (dims.length) properties.dimensions = dims.join(' x ');
  }
  if (product.variation) properties.variation = String(product.variation);
  for (const attr of product.attributes || []) {
    const terms = (attr.terms || []).map((term) => term.name || term.value || term.slug).filter(Boolean);
    if (attr.name && terms.length) properties[attr.name] = terms.join(', ');
  }

  return {
    source: 'woocommerce',
    sourceType,
    id: product.id ?? null,
    parentId: product.parent || null,
    name: cleanProductName(product.name),
    url: product.permalink || null,
    sku: product.sku || null,
    price: priceFromWoo(product.prices),
    price_vat_status: inferWooProductVatStatusFromApi(product) || priceVatStatus || 'ismeretlen',
    currency: product.prices?.currency_code || null,
    category: (product.categories || []).map((cat) => cat.name).filter(Boolean).join(', ') || null,
    description: stripHtml(product.short_description || product.description || ''),
    images: (product.images || []).map((img) => img.src).filter(Boolean),
    properties,
    variants: (product.variations || []).map((variation) => ({
      id: String(variation.id),
      attributes: JSON.stringify(variation.attributes || []),
    })),
  };
}

async function pushProduct(product) {
  if (!product?.name) return false;
  if (!product.price_vat_status) {
    product.price_vat_status = product.price ? inferPriceVatStatus(`${product.price} ${product.description || ''}`) : 'ismeretlen';
  }
  if (product.url) {
    try {
      product.url = normalizeUrl(product.url);
    } catch {
      // Keep the original URL if normalization fails.
    }
  }
  const key = `${product.url || ''}|${product.sku || ''}|${product.name}|${product.properties?.variation || ''}`;
  if (seenProducts.has(key)) return false;
  if (productCount >= input.maxProducts) return false;
  seenProducts.add(key);
  productCount += 1;
  if (input.enableCanonicalGrouping !== false) {
    const canonical = resolveCanonical(product, canonicalByGroup);
    if (canonical) product.canonical = canonical;
  }
  await Actor.pushData(product);
  await enqueueWebhookProduct(product);
  if (productCount % 100 === 0) {
    Actor.setStatusMessage(`Stored ${productCount} products`);
  }
  return true;
}

async function tryWooCommerce(baseUrl, options) {
  const firstUrl = `${baseUrl}/wp-json/wc/store/v1/products?per_page=1&page=1`;
  const first = await fetchJson(firstUrl);
  if (!Array.isArray(first)) return { handled: false };

  log.info('WooCommerce Store API detected');
  const wooPriceVatStatus = await detectWooCommerceVatStatus(baseUrl, first[0], options);
  for (let page = 1; productCount < options.maxProducts; page += 1) {
    const url = `${baseUrl}/wp-json/wc/store/v1/products?per_page=100&page=${page}`;
    const products = await fetchJson(url);
    if (!Array.isArray(products) || products.length === 0) break;
    for (const product of products) {
      await pushProduct(normalizeWooProduct(product, 'product', wooPriceVatStatus));
      if (productCount >= options.maxProducts) break;
    }
  }

  if (options.includeVariants && productCount < options.maxProducts) {
    for (let page = 1; productCount < options.maxProducts; page += 1) {
      const url = `${baseUrl}/wp-json/wc/store/v1/products?type=variation&per_page=100&page=${page}`;
      const variations = await fetchJson(url);
      if (!Array.isArray(variations) || variations.length === 0) break;
      for (const variation of variations) {
        await pushProduct(normalizeWooProduct(variation, 'variation', wooPriceVatStatus));
        if (productCount >= options.maxProducts) break;
      }
    }
  }

  return { handled: productCount > 0 };
}

function normalizeShopifyProduct(product, baseUrl) {
  const firstVariant = product.variants?.[0] || {};
  const properties = {};
  if (product.vendor) properties.vendor = String(product.vendor);
  if (product.product_type) properties.product_type = String(product.product_type);
  for (const option of product.options || []) {
    if (option.name && option.values?.length) properties[option.name] = option.values.join(', ');
  }
  return {
    source: 'shopify',
    sourceType: 'product',
    id: product.id ?? null,
    parentId: null,
    name: cleanProductName(product.title),
    url: `${baseUrl}/products/${product.handle}`,
    sku: firstVariant.sku || null,
    price: firstVariant.price || null,
    price_vat_status: 'ismeretlen',
    currency: null,
    category: product.product_type || null,
    description: stripHtml(product.body_html || ''),
    images: (product.images || []).map((img) => img.src).filter(Boolean),
    properties,
    variants: (product.variants || []).map((variant) => ({
      id: String(variant.id),
      title: variant.title || '',
      sku: variant.sku || '',
      price: variant.price || '',
      available: String(variant.available ?? ''),
    })),
  };
}

async function tryShopify(baseUrl, options) {
  const first = await fetchJson(`${baseUrl}/products.json?limit=1&page=1`);
  if (!first?.products || !Array.isArray(first.products)) return { handled: false };

  log.info('Shopify products.json detected');
  for (let page = 1; productCount < options.maxProducts; page += 1) {
    const data = await fetchJson(`${baseUrl}/products.json?limit=250&page=${page}`);
    const products = data?.products || [];
    if (!products.length) break;
    for (const product of products) {
      await pushProduct(normalizeShopifyProduct(product, baseUrl));
      if (productCount >= options.maxProducts) break;
    }
  }
  return { handled: productCount > 0 };
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function valueText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return cleanText(value);
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join(', ');
  return cleanText(value.name || value.value || value['@id'] || value.url || '');
}

function flattenLdNodes(node) {
  const nodes = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    nodes.push(value);
    if (Array.isArray(value['@graph'])) value['@graph'].forEach(visit);
    if (value.mainEntity) visit(value.mainEntity);
    if (value.itemListElement) value.itemListElement.forEach((item) => visit(item.item || item));
  };
  visit(node);
  return nodes;
}

function normalizeLdType(type) {
  return asArray(type).map((item) => String(item).toLowerCase());
}

function extractJsonLdProducts($, url) {
  const products = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      for (const node of flattenLdNodes(parsed)) {
        const types = normalizeLdType(node['@type']);
        if (types.some((type) => ['product', 'productmodel', 'productgroup'].includes(type) || type.endsWith('/product'))) {
          const offer = asArray(node.offers)[0] || {};
          const aggregateOffer = offer['@type'] && String(offer['@type']).toLowerCase().includes('aggregateoffer') ? offer : {};
          const properties = {};
          for (const property of asArray(node.additionalProperty)) {
            const key = valueText(property.name || property.propertyID);
            const value = valueText(property.value);
            if (key && value) properties[key] = value;
          }
          if (node.brand) properties.brand = valueText(node.brand);
          if (node.model) properties.model = valueText(node.model);
          if (node.color) properties.color = valueText(node.color);
          if (node.material) properties.material = valueText(node.material);
          if (node.gtin || node.gtin13 || node.gtin14 || node.gtin8) {
            properties.gtin = valueText(node.gtin || node.gtin13 || node.gtin14 || node.gtin8);
          }

          const rawOfferPrice = valueText(offer.price);
          const price = firstNonEmpty(
            Number(rawOfferPrice) === 0 && rawOfferPrice !== '' ? '' : rawOfferPrice,
            offer.lowPrice && offer.highPrice ? `${offer.lowPrice} - ${offer.highPrice}` : '',
            aggregateOffer.lowPrice && aggregateOffer.highPrice ? `${aggregateOffer.lowPrice} - ${aggregateOffer.highPrice}` : '',
          );
          const currency = valueText(offer.priceCurrency || aggregateOffer.priceCurrency);
          const priceSpecification = asArray(offer.priceSpecification)[0] || asArray(aggregateOffer.priceSpecification)[0] || {};
          let priceVatStatus = inferPriceVatStatus(valueText(priceSpecification.name || priceSpecification.description));
          if (priceSpecification.valueAddedTaxIncluded === true) priceVatStatus = 'bruttó';
          if (priceSpecification.valueAddedTaxIncluded === false) priceVatStatus = 'nettó';
          products.push({
            source: 'json_ld',
            sourceType: 'product',
            id: node.sku || node.mpn || null,
            parentId: null,
            name: cleanProductName(valueText(node.name)),
            url: node.url ? new URL(node.url, url).toString() : url,
            sku: node.sku || node.mpn || null,
            price: price ? `${price}${currency ? ` ${currency}` : ''}` : null,
            price_vat_status: priceVatStatus,
            currency: currency || null,
            category: valueText(node.category) || extractCategory($, valueText(node.name)) || categoryFromUrlPath($, url) || null,
            description: truncate(firstNonEmpty(
              stripHtml(valueText(node.description)),
              $('meta[name="description"]').attr('content'),
              extractMainContentText($),
            ), 3000),
            images: normalizeImages(node.image, url),
            properties,
            variants: [],
          });
        }
      }
    } catch {
      // Ignore invalid JSON-LD.
    }
  });
  return products;
}

function normalizeImages(value, baseUrl) {
  const images = Array.isArray(value) ? value : value ? [value] : [];
  return unique(images
    .flatMap((item) => (Array.isArray(item) ? item : [item]))
    .map((item) => (typeof item === 'string' ? item : item?.url || item?.contentUrl || item?.thumbnailUrl))
    .filter(Boolean)
    .map((src) => new URL(src, baseUrl).toString()));
}

function detectPlatform($, url) {
  const lowerUrl = url.toLowerCase();
  const html = $('html').html()?.slice(0, 250000).toLowerCase() || '';
  const generator = cleanText($('meta[name="generator"]').attr('content')).toLowerCase();
  if (lowerUrl.includes('myshopify.com') || html.includes('cdn.shopify.com') || generator.includes('shopify')) return 'shopify_html';
  if (lowerUrl.includes('shop_artdet.php') || lowerUrl.includes('unas.hu') || lowerUrl.includes('unasshop') || html.includes('unas') || html.includes('shop_artdet.php')) return 'unas_html';
  if (html.includes('shoprenter') || html.includes('cdn.shoprenter.hu')) return 'shoprenter_html';
  if (generator.includes('woocommerce') || html.includes('woocommerce') || html.includes('wp-content/plugins/woocommerce')) return 'woocommerce_html';
  if (generator.includes('magento') || html.includes('/static/frontend/') || html.includes('magento_') || lowerUrl.includes('/catalog/product/view')) return 'magento_html';
  if (generator.includes('prestashop') || html.includes('prestashop') || lowerUrl.includes('controller=product')) return 'prestashop_html';
  if (generator.includes('opencart') || html.includes('index.php?route=product/product') || lowerUrl.includes('route=product/product')) return 'opencart_html';
  if (generator.includes('shopware') || html.includes('shopware')) return 'shopware_html';
  return 'html';
}

function addProperty(properties, key, value) {
  const cleanKey = cleanText(key).replace(/[:：]+$/, '');
  const cleanValue = cleanText(value);
  if (!cleanKey || !cleanValue) return;
  if (cleanKey.length > 100 || cleanValue.length > 600) return;
  if (cleanKey.toLowerCase() === cleanValue.toLowerCase()) return;
  if (!properties[cleanKey]) properties[cleanKey] = cleanValue;
}

function extractProperties($) {
  const properties = {};

  $('table tr').each((_i, tr) => {
    const cells = $(tr).find('th,td').map((_j, cell) => cleanText($(cell).text())).get();
    if (cells.length >= 2) addProperty(properties, cells[0], cells.slice(1).join(' '));
  });

  $('dl, .specifications, .product-attributes, .woocommerce-product-attributes').find('dt, th').each((_i, label) => {
    addProperty(properties, $(label).text(), $(label).next('dd,td').text());
  });

  for (const selector of PROPERTY_BLOCK_SELECTORS) {
    $(selector).find('li, p, div').each((_i, el) => {
      const text = cleanText($(el).text());
      const match = text.match(/^([^:：]{2,100})[:：]\s*(.{1,600})$/);
      if (match) addProperty(properties, match[1], match[2]);
    });
  }

  $('[itemprop]').each((_i, el) => {
    const key = cleanText($(el).attr('itemprop'));
    if (!key || ['name', 'description', 'image', 'url', 'offers'].includes(key)) return;
    const value = cleanText($(el).attr('content') || $(el).attr('href') || $(el).text());
    addProperty(properties, key, value);
  });

  return properties;
}

function extractProductImages($, url) {
  const candidates = [
    $('meta[property="og:image"]').attr('content'),
    $('meta[name="twitter:image"]').attr('content'),
    $('[itemprop="image"]').first().attr('content'),
    $('[itemprop="image"]').first().attr('src'),
  ];

  $('.product img, .product-detail img, .product-info img, .product-page img, .gallery img, .images img, [class*="product"] img').each((_i, img) => {
    candidates.push($(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-original'));
  });

  return normalizeImages(candidates, url).slice(0, 20);
}

function inferSku($, properties) {
  const direct = firstNonEmpty(
    properties.SKU,
    properties.sku,
    properties.Cikkszam,
    properties['Cikkszám'],
    properties['Cikk szám'],
    properties['Termékkód'],
    properties['Product code'],
    $('[itemprop="sku"]').first().attr('content'),
    $('[itemprop="sku"]').first().text(),
    $('.sku, .product-sku, [class*="sku"], [class*="cikkszam"], [class*="cikksz"]').first().text(),
  );
  if (direct) return direct;

  const text = cleanText($('body').text());
  const match = text.match(/(?:SKU|Cikksz[áa]m|Term[ée]kk[óo]d|Rendel[ée]si\s+(?:k[óo]d|sz[áa]m)|Order\s+(?:code|no\.?)|Article(?:\s+no\.?)?)[:\s#»-]{1,10}([A-Za-z0-9._/-]{3,80})/i);
  return match ? match[1] : null;
}

function extractCategory($, productName = '') {
  const genericRoots = new Set([
    'home', 'főoldal', 'kezdőlap', 'kezdolap', 'fooldal', 'kezdőoldal', 'kezdooldal', 'startseite', 'start',
    'termékek', 'termekek', 'products', 'shop', 'webshop', 'áruház', 'aruhaz',
    'értékesítés', 'ertekesites', 'kategóriák', 'kategoriak', 'katalógus', 'katalogus',
  ]);
  const own = cleanText(productName).toLowerCase();
  const clean = (items) => unique(items.filter(Boolean))
    .filter((item) => item.toLowerCase() !== own)
    .filter((item) => !genericRoots.has(item.toLowerCase()));
  const scope = $('.breadcrumb, .breadcrumbs, nav[aria-label*="breadcrumb" i], [class*="breadcrumb"]').first();
  if (scope.length) {
    const crumbs = scope.find('li').length
      ? scope.find('li').map((_i, el) => cleanText($(el).text())).get()
      : scope.find('a').map((_i, el) => cleanText($(el).text())).get();
    const path = clean(crumbs);
    if (path.length) return path.join(' > ');
  }
  // Pseudo-breadcrumb heading: "» Laboratóriumi műanyagáru » Tartók, rackek, dobozok".
  let chain = null;
  mainContentScope($).find('h2, h3, h4, h5').each((_i, el) => {
    if (chain) return;
    const text = cleanText($(el).text());
    if (text.length > 200 || !/^[»›]/.test(text)) return;
    const parts = clean(text.split(/\s*[»›]\s*/));
    if (parts.length) chain = parts.join(' > ');
  });
  return chain;
}

// No breadcrumb: rebuild the category path from the URL's parent segments, using the
// site's own link text for each parent path (e.g. /termekek/<category>/<product>).
function categoryFromUrlPath($, url) {
  let segments;
  try {
    segments = new URL(url).pathname.replace(/\/$/, '').split('/').filter(Boolean);
  } catch {
    return null;
  }
  if (segments.length < 2) return null;
  const linkText = new Map();
  $('a[href]').each((_i, el) => {
    try {
      const path = new URL($(el).attr('href'), url).pathname.replace(/\/$/, '').toLowerCase();
      const text = cleanText($(el).text());
      if (text && !linkText.has(path)) linkText.set(path, text);
    } catch {
      // ignore malformed links
    }
  });
  const genericRoots = categorySegments();
  const names = [];
  for (let i = 1; i < segments.length; i += 1) {
    const prefix = `/${segments.slice(0, i).join('/')}`.toLowerCase();
    let decoded = segments[i - 1];
    try {
      decoded = decodeURIComponent(decoded).toLowerCase();
    } catch {
      decoded = decoded.toLowerCase();
    }
    if (i === 1 && (genericRoots.has(decoded) || ['ertekesites', 'értékesítés', 'shop', 'webshop'].includes(decoded))) continue;
    const name = linkText.get(prefix) || linkText.get(encodeURI(decodeURIComponent(prefix)).toLowerCase());
    if (!name) return names.length ? names.join(' > ') : null;
    names.push(name);
  }
  return names.length ? names.join(' > ') : null;
}

function siteBrand($) {
  const brand = firstNonEmpty(
    $('meta[property="og:site_name"]').attr('content'),
    $('.logo img').first().attr('alt'),
    $('.logo').first().text(),
    $('[itemtype*="Organization"] [itemprop="name"]').first().text(),
  );
  return brand || hostKey(startUrl).split('.')[0];
}

function stripSiteBrand(title, $) {
  let clean = cleanText(title);
  const brands = unique([siteBrand($), hostKey(startUrl), `www.${hostKey(startUrl)}`].map((b) => cleanText(b).toLowerCase()));
  for (const brand of brands) {
    if (!brand) continue;
    const pattern = new RegExp(`(^\\s*${escapeRegex(brand)}\\s*[|\\-–—:•»]+\\s*|\\s*[|\\-–—:•»]+\\s*${escapeRegex(brand)}\\s*$)`, 'i');
    clean = clean.replace(pattern, '');
  }
  return cleanText(clean.replace(/^[\s|\-–—:•»]+|[\s|\-–—:•»]+$/g, ''));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Header contact lines, share buttons and section headings are not product names.
function isJunkTitle(title) {
  const clean = cleanText(title);
  if (!clean) return true;
  if (/^[+()\d\s./-]{7,}$/.test(clean)) return true; // phone number
  if (/^\S+@\S+\.\S+$/.test(clean)) return true; // e-mail
  if (/^(https?:\/\/|www\.)/i.test(clean)) return true;
  const folded = clean.toLowerCase();
  if (/(megoszt|ossza meg|share on|share this|facebook|twitter|linkedin|pinterest)/i.test(folded)) return true;
  return [
    'műszaki adatok', 'muszaki adatok', 'technical data', 'termékleírás', 'leírás', 'description',
    'kapcsolat', 'contact', 'kosár', 'kosar', 'cart', 'menü', 'menu', 'keresés', 'search',
  ].includes(folded);
}

function isGenericTitle(title, $) {
  const clean = cleanText(title).toLowerCase();
  const brand = siteBrand($).toLowerCase();
  if (!clean) return true;
  if (clean === brand) return true;
  if (clean === hostKey(startUrl).toLowerCase()) return true;
  if (clean.length < 3) return true;
  if (isJunkTitle(clean)) return true;
  if (stripSiteBrand(clean, $).length < 3) return true;
  return false;
}

function mainContentScope($) {
  const main = $('main, [role="main"], #main, .main, #content, .content').first();
  return main.length ? main : $('body');
}

// Sites without a usable <h1>/<title> (e.g. biocenter.hu: " | biocenter.hu"): first bold
// line of the main content, outside navigation/sidebars.
function boldTitleFallback($) {
  const scope = mainContentScope($).clone();
  scope.find('nav, aside, header, footer, form, script, style, .breadcrumb, .sidebar, .menu').remove();
  let found = '';
  scope.find('b, strong, .card-title, h2, h3').each((_i, el) => {
    if (found) return;
    const text = cleanText($(el).text());
    if (text.length >= 3 && text.length <= 160 && !isJunkTitle(text) && !/[»›]/.test(text) && !/[:：]$/.test(text)) found = text;
  });
  return found;
}

function extractPageTitle($, url = '') {
  const productScope = $('[itemscope][itemtype*="Product"]').first();
  const productScopedTitle = productScope.length
    ? firstNonEmpty(
      productScope.find('[itemprop="name"]').first().attr('content'),
      productScope.find('[itemprop="name"]').first().text(),
      productScope.find('h1, h2, .product-title, .product-name').first().text(),
    )
    : '';

  // Product-name classes are only trustworthy when the page has exactly one of them;
  // on listing pages (Shopware .product-name x20) the first card name was taken as the page title.
  const nameSelector = '.product-title, .product-name, .product-detail-title, .p-name, [class*="product-title"], [class*="product-name"]';
  const outsideCards = (_i, el) => !$(el).closest('[data-pcc-card]').length;
  const containerName = $(PRODUCT_CONTAINER_SELECTORS.join(', ')).filter(outsideCards).first().find(nameSelector).first().text();
  const nameEls = $(nameSelector).filter(outsideCards).filter((_i, el) => !$(el).parents(nameSelector).length);
  const singleName = nameEls.length === 1 ? nameEls.first().text() : '';

  const docTitle = stripSiteBrand($('title').first().text(), $);
  const ogTitle = stripSiteBrand($('meta[property="og:title"]').attr('content'), $);
  const h1s = $('h1').map((_i, el) => cleanText($(el).text())).get().filter((t) => !isJunkTitle(t));
  const docFold = docTitle.toLowerCase();
  const matchingH1 = h1s.find((t) => docFold && (docFold.includes(t.toLowerCase()) || t.toLowerCase().includes(docFold)));
  const mainH1 = $('main h1, [role="main"] h1').map((_i, el) => cleanText($(el).text())).get().find((t) => !isJunkTitle(t));

  const candidate = firstNonEmpty(
    productScopedTitle,
    containerName,
    singleName,
    matchingH1,
    mainH1,
    h1s[0],
    ogTitle,
    docTitle,
  );
  if (candidate && !isJunkTitle(candidate) && stripSiteBrand(candidate, $).length >= 3) return candidate;
  if (url && scoreUrl(url) >= 100) return boldTitleFallback($);
  return candidate;
}

function countSignals(pageText) {
  return PRODUCT_TEXT_SIGNALS.reduce((count, signal) => count + (pageText.includes(signal) ? 1 : 0), 0);
}

function countServiceSignals(pageText) {
  return SERVICE_TEXT_SIGNALS.reduce((count, signal) => count + (pageText.includes(signal) ? 1 : 0), 0);
}

function hasStrongProductMarker($) {
  return Boolean(
    $('[itemscope][itemtype*="Product"]').length
    || $('[itemprop="sku"], [itemprop="mpn"], [itemprop="gtin"], [itemprop="price"]').length
    || $('form[action*="cart"], form[action*="kosar"], button[name*="add"], button[class*="cart"], .add-to-cart, .kosarba').length
    || $('[data-product-id], [data-sku]').length
  );
}

function hasStrongServiceMarker($, url) {
  if (!input.includeServices) return false;
  if (!isServiceUrl(url)) return false;
  const path = new URL(url).pathname.replace(/\/$/, '').toLowerCase();
  if (['/szolgaltatasok', '/szolgáltatások', '/services', '/service'].includes(path)) return false;
  const pageText = cleanText($('body').text()).toLowerCase();
  return countServiceSignals(pageText) >= 2;
}

function productConfidence({ $, url, title, priceText, properties, sku, description }) {
  let score = 0;
  const urlScore = scoreUrl(url);
  const pageText = cleanText($('body').text()).toLowerCase();

  if (urlScore >= 100) score += 35;
  else if (urlScore >= 50) score += 20;
  else if (urlScore >= 10) score += 5;

  if (hasStrongProductMarker($)) score += 35;
  if (priceText) score += 20;
  if (sku) score += 25;
  if (Object.keys(properties || {}).length >= 2) score += 20;
  if (Object.keys(properties || {}).length >= 5) score += 10;
  if (description && description.length > 80) score += 10;
  if (countSignals(pageText) >= 3) score += 10;
  if (hasStrongServiceMarker($, url)) score += 35;
  if (input.includeServices && isServiceUrl(url) && countServiceSignals(pageText) >= 3) score += 15;
  if (!isGenericTitle(title, $)) score += 20;
  else score -= 50;

  return score;
}

function extractListingProducts($, url) {
  const products = [];
  const seenCards = new Set();
  const platform = detectPlatform($, url);
  const category = extractCategory($);
  const selectors = LISTING_CARD_SELECTORS;

  for (const selector of selectors) {
    $(selector).each((_i, card) => {
      const $card = $(card);
      const text = cleanText($card.text());
      if (!text || text.length < 5) return;

      // Cards wrapped in a link (<a href><div class="product-box">…</div></a>, leotrade.hu).
      const wrappingLink = $card.closest('a[href]');
      const linkEl = [...$card.find('a[href]').toArray(), ...wrappingLink.toArray()]
        .map((el) => {
          const href = $(el).attr('href');
          try {
            return {
              href,
              absUrl: href ? new URL(href, url).toString() : '',
              text: cleanText($(el).attr('title') || $(el).text()),
              isLightbox: /fancybox|lightbox|gallery|zoom/i.test(`${$(el).attr('class') || ''} ${$(el).attr('rel') || ''} ${$(el).attr('data-fancybox') !== undefined ? 'fancybox' : ''}`),
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((item) => item.href && !/^(#|javascript:|mailto:|tel:)/i.test(item.href))
        // Share buttons (facebook.com/sharer...?u=<product url>) scored high on the embedded URL.
        .filter((item) => !item.isLightbox && !shouldSkipUrl(item.absUrl) && !isJunkTitle(item.text || 'x'))
        .sort((a, b) => scoreUrl(b.absUrl) - scoreUrl(a.absUrl))[0];
      if (!linkEl) return;

      const title = firstNonEmpty(
        $card.find('[itemprop="name"]').first().attr('content'),
        $card.find('[itemprop="name"]').first().text(),
        $card.find('.product-title, .product-name, .card-title, .title, .name, h1, h2, h3, h4').first().text(),
        linkEl?.text,
      );
      const cleanTitle = cleanProductName(title);
      if (!cleanTitle || cleanTitle.length > 220) return;
      if (isGenericTitle(cleanTitle, $)) return;
      if (shouldSkipUrl(linkEl.absUrl)) return;

      const productUrl = linkEl.absUrl;
      const cardUrlScore = scoreUrl(productUrl);
      const cardHasProductMarker = $card.find('[itemprop="sku"], [itemprop="price"], [data-product-id], [data-sku], .price, .product-price, .add-to-cart, .kosarba').length > 0;
      if (cardUrlScore < 50 && !cardHasProductMarker) return;

      const key = `${productUrl}|${cleanTitle}`;
      $card.attr('data-pcc-card', '1');
      if (seenCards.has(key)) return;
      seenCards.add(key);

      const image = firstNonEmpty(
        $card.find('img').first().attr('src'),
        $card.find('img').first().attr('data-src'),
        $card.find('img').first().attr('data-original'),
      );
      const priceText = firstNonEmpty(
        $card.find('[itemprop="price"]').first().attr('content'),
        $card.find('.price, .ar, .termek-ar, .product-price, [class*="price"], [class*="Price"]').first().text(),
      );
      const cardPriceInfo = extractPriceInfoFromText(priceText) || extractPriceInfoNearLabels(text, PRODUCT_PRICE_LABELS);

      products.push({
        source: `${platform}_listing`,
        sourceType: 'product',
        id: $card.attr('data-product-id') || null,
        parentId: null,
        name: cleanTitle,
        url: productUrl,
        sku: null,
        price: cardPriceInfo?.price || null,
        price_vat_status: cardPriceInfo?.price_vat_status || 'ismeretlen',
        currency: null,
        category,
        description: truncate(stripHtml($card.find('.description, .summary, [class*="desc"]').first().text()), 1000),
        images: image ? normalizeImages(image, url) : [],
        properties: {},
        variants: [],
      });
    });
    if (products.length >= 100) break;
  }

  return products;
}


function categorySegments() {
  return new Set(CATEGORY_URL_HINTS.map((hint) => hint.replace(/\//g, '').toLowerCase()).filter(Boolean));
}

// /termekek/<category>/<product> style page that is not itself a listing of children.
function isCatalogLeafPage($, url) {
  let path;
  try {
    path = decodeURIComponent(new URL(url).pathname).toLowerCase().replace(/\/$/, '');
  } catch {
    return false;
  }
  const segments = path.split('/').filter(Boolean);
  const rootIndex = segments.findIndex((segment) => categorySegments().has(segment));
  if (rootIndex < 0 || segments.length - rootIndex < 3) return false;
  const childLinks = new Set();
  $('a[href]').each((_i, el) => {
    try {
      const childPath = decodeURIComponent(new URL($(el).attr('href'), url).pathname).toLowerCase().replace(/\/$/, '');
      if (childPath.startsWith(`${path}/`)) childLinks.add(childPath);
    } catch {
      // ignore malformed links
    }
  });
  return childLinks.size < 3;
}

// A product detail page may also show 'related products' cards. It is a real detail page
// when, after removing all cards, it still has its own spec table or SKU.
function hasOwnProductDetail($) {
  const $own = cheerio.load($.html());
  $own('[data-pcc-card]').remove();
  $own('header, footer, nav, aside').remove();
  // Key-value spec rows only (2 cells / dt-dd). Multi-column rows are comparison tables of
  // the listed products (lutz-jesco.com category pages), not this page's own specs.
  let specRows = 0;
  $own('table tr').each((_i, tr) => {
    if ($own(tr).children('th,td').length === 2 && cleanText($own(tr).text()).length > 3) specRows += 1;
  });
  specRows += $own('dl dt').length;
  if (specRows >= 3) return true;
  return Boolean(inferSku($own, {}));
}

function extractMainContentText($) {
  const h1 = $('h1').first();
  if (!h1.length) return '';
  let container = h1.parent();
  for (let i = 0; i < 4 && container.length && cleanText(container.text()).length < 200; i += 1) {
    container = container.parent();
  }
  if (!container.length || container.is('body, html')) return '';
  const clone = container.clone();
  clone.find('script, style, noscript, nav, header, footer, form, table, h1, .breadcrumb, .menu, .mean-container').remove();
  return cleanText(clone.text());
}

function extractDomProduct($, url) {
  if (isNotFoundPage($)) return null;
  const title = cleanProductName(extractPageTitle($, url));
  const platform = detectPlatform($, url);
  const properties = extractProperties($);
  const isServiceRecord = hasStrongServiceMarker($, url);
  if (isServiceRecord) {
    properties.record_type = 'service';
  }
  const priceInfoResult = extractDomPriceInfo($, properties, isServiceRecord);
  const priceText = priceInfoResult?.price || null;
  const sku = inferSku($, properties);
  const description = firstNonEmpty(
    $('meta[name="description"]').attr('content'),
    $('[itemprop="description"]').first().attr('content'),
    $('[itemprop="description"]').first().text(),
    $('.summary, .description, .product-description, .short-description, .product-short-description, [class*="description"]').first().text(),
    extractMainContentText($),
  );
  const cleanDescription = stripHtml(description);
  let confidence = productConfidence({ $, url, title, priceText, properties, sku, description: cleanDescription });
  // Catalog sites without prices/cart (e.g. B2B manufacturer pages): a leaf page under the
  // product catalog path with a real title and descriptive text is a product.
  if (isCatalogLeafPage($, url) && cleanDescription.length >= 150) confidence += 40;
  if (!title || confidence < 55) return null;

  return {
    source: platform,
    sourceType: 'product',
    id: null,
    parentId: null,
    name: title,
    url,
    sku,
    price: priceText,
    price_vat_status: priceInfoResult?.price_vat_status || 'ismeretlen',
    currency: null,
    category: extractCategory($, title) || categoryFromUrlPath($, url),
    description: truncate(cleanDescription, 3000),
    images: extractProductImages($, url),
    properties,
    variants: [],
  };
}

async function seedFromFirecrawlMap(options) {
  if (!options.firecrawlApiKey) return [];
  try {
    const response = await fetch('https://api.firecrawl.dev/v1/map', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.firecrawlApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: startUrl,
        search: 'product termek shop webshop catalog katalogus',
        limit: Math.min(options.maxPages, 5000),
      }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    const links = data.links || data.data?.links || [];
    return links.map((item) => (typeof item === 'string' ? item : item.url)).filter(Boolean);
  } catch (error) {
    summary.warnings.push(`Firecrawl map failed: ${error.message}`);
    return [];
  }
}

// Sitemaps are often served gzipped as application/octet-stream (*.xml.gz, e.g. Shopware).
async function fetchSitemapText(url, attempt = 1) {
  try {
    const response = await fetchWithPacing(url, {
      headers: {
        accept: 'application/xml,text/xml,application/gzip,*/*',
        'user-agent': 'ProductCatalogCrawler/1.0 (+https://apify.com)',
      },
    });
    // On-demand generated sitemaps answer 503 now and then (doerken.com /hu/hu/sitemap.xml).
    if (response && [429, 500, 502, 503, 504].includes(Number(response.status)) && attempt < 3) {
      await wait(3000 * attempt);
      return fetchSitemapText(url, attempt + 1);
    }
    if (!response?.ok) return null;
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) return gunzipSync(raw).toString('utf8');
    return raw.toString('utf8');
  } catch (error) {
    summary.warnings.push(`Sitemap fetch failed: ${url} - ${error.message}`);
    return null;
  }
}

async function parseSitemap(url, depth = 0) {
  if (depth > 2) return [];
  const text = await fetchSitemapText(url);
  if (!text || !isLikelyXml(text)) return [];

  const $xml = cheerio.load(text, { xmlMode: true });
  const sitemapUrls = [];
  $xml('sitemap loc').each((_i, el) => sitemapUrls.push(cleanText($xml(el).text())));

  const urls = [];
  $xml('url loc').each((_i, el) => urls.push(cleanText($xml(el).text())));

  let childSitemaps = sitemapUrls.filter((childUrl) => sameDomain(childUrl));
  // Sitemap index of a multilingual site: read only the start URL's language sitemaps.
  if (scopePrefix && childSitemaps.some((childUrl) => inScope(childUrl))) {
    childSitemaps = childSitemaps.filter((childUrl) => inScope(childUrl));
  }
  for (const childUrl of childSitemaps.slice(0, 30)) {
    urls.push(...await parseSitemap(childUrl, depth + 1));
  }

  return unique(urls);
}

async function seedFromSitemaps(options) {
  const robotsText = await fetchText(`${origin}/robots.txt`, { accept: 'text/plain,*/*' });
  const robotsSitemaps = String(robotsText || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*sitemap\s*:\s*(\S+)/i)?.[1])
    .filter(Boolean);
  // Language-specific sitemaps first (robots.txt may list 25 locales; /hu/sitemap.xml was last).
  const scopedRobotsSitemaps = robotsSitemaps.filter((url) => sameDomain(url) && scopePrefix && inScope(url));
  const candidates = unique([
    ...scopedRobotsSitemaps,
    scopePrefix ? `${origin}${scopePrefix}/sitemap.xml` : '',
    ...robotsSitemaps.filter((url) => !scopedRobotsSitemaps.includes(url)),
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/product-sitemap.xml`,
  ]).slice(0, 5);

  const urls = [];
  for (const url of candidates) {
    if (urls.length >= options.maxPages) break;
    try {
      const discovered = await parseSitemap(url);
      urls.push(...discovered);
      if (discovered.length > 0) break;
    } catch (error) {
      summary.warnings.push(`Sitemap failed: ${url} - ${error.message}`);
    }
  }

  return unique(urls)
    .filter((url) => {
      try {
        return !shouldSkipUrl(url);
      } catch {
        return false;
      }
    })
    .sort((a, b) => scoreUrl(b) - scoreUrl(a))
    .slice(0, options.maxPages);
}

function isNotFoundPage($) {
  const signals = cleanText([
    $('title').first().text(),
    $('meta[property="og:title"]').attr('content') || '',
    $('h1').first().text(),
  ].join(' ')).toLowerCase();
  return /(^|\D)404(\D|$)|nem található|nem talalhato|nem létezik|not found|page not found/.test(signals);
}

function looksLikeProductDetailHtml(html) {
  const $ = cheerio.load(String(html || ''));
  if (isNotFoundPage($)) return false;
  $('head, script, style, noscript').remove();
  // Only visible body text counts: meta tags / og:url of a 404 template must not trigger.
  const lower = cleanText($('body').text()).toLowerCase();
  const markers = [
    'bruttó termék ár',
    'brutto termek ar',
    'műszaki adatok',
    'muszaki adatok',
    'megrendelés szerelés nélkül',
    'megrendeles szereles nelkul',
    'termék részletek',
    'termek reszletek',
    'product details',
    'product_detail',
    'product_details',
  ];
  return markers.some((marker) => lower.includes(marker));
}

async function seedFromGeneratedProductIds(options) {
  const patterns = [
    `${origin}/product_details.php?id={id}`,
    `${origin}/product_detail.php?id={id}`,
    `${origin}/product_info.php?id={id}`,
  ];
  const limit = Math.min(
    Number.isFinite(Number(options.generatedProductIdLimit)) ? Number(options.generatedProductIdLimit) : 300,
    Math.max(20, options.maxPages),
    1000,
  );

  for (const pattern of patterns) {
    // Probe several ids; a single (possibly soft-404) page is not proof of a live pattern.
    let hits = 0;
    for (const id of [1, 2, 3]) {
      const sample = await fetchText(pattern.replace('{id}', String(id)));
      if (sample && looksLikeProductDetailHtml(sample)) hits += 1;
    }
    if (hits < 2) continue;
    log.info(`Sequential product detail pattern detected: ${pattern}`);
    return Array.from({ length: limit }, (_item, index) => pattern.replace('{id}', String(index + 1)));
  }

  return [];
}

async function crawlHtmlFallback(options) {
  const firecrawlSeeds = await seedFromFirecrawlMap(options);
  const sitemapSeeds = await seedFromSitemaps(options);
  const generatedProductSeeds = await seedFromGeneratedProductIds(options);
  const startUrls = [startUrl, ...generatedProductSeeds, ...sitemapSeeds, ...firecrawlSeeds]
    .filter((url) => {
      try {
        return !shouldSkipUrl(url);
      } catch {
        return false;
      }
    })
    .sort((a, b) => scoreUrl(b) - scoreUrl(a))
    .slice(0, Math.min(options.maxPages, 5000));

  const throttleSettings = {
    maxConcurrency: options.maxConcurrency,
    maxRequestsPerMinute: options.maxRequestsPerMinute,
    sameDomainDelaySecs: options.sameDomainDelaySecs,
    maxRequestRetries: options.maxRequestRetries,
  };
  log.info('Crawler throttle settings', throttleSettings);

  // NOTE: sameDomainDelaySecs is NOT passed to Crawlee. Crawlee implements it by
  // reclaiming the request to the queue, which on the Apify platform makes the
  // request reappear only after ~60 s (=> 1 page/min). We pace in-process instead.
  const { sameDomainDelaySecs: _ignoredDelay, ...crawleeThrottle } = throttleSettings;

  const proxyConfiguration = await getProxyConfiguration(options);
  if (proxyConfiguration) {
    log.info('Crawler proxy enabled', {
      mode: options.proxyMode,
      country: options.proxyMode === 'residential' ? options.proxyCountry : null,
    });
  } else {
    log.warning('Crawler proxy disabled; IP-based blocking may cause HTTP 429 responses');
  }

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: options.maxPages,
    minConcurrency: 1,
    ...crawleeThrottle,
    proxyConfiguration,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
      maxPoolSize: 20,
      sessionOptions: {
        maxUsageCount: 25,
      },
    },
    retryOnBlocked: true,
    requestHandlerTimeoutSecs: 60,
    preNavigationHooks: [
      async ({ request }) => {
        await paceTargetRequest(request.url);
      },
    ],
    postNavigationHooks: [
      async ({ request, response }) => {
        registerTargetThrottleSignal(request.url, response?.statusCode);
      },
    ],
    async requestHandler({ $, request, enqueueLinks }) {
      pageCount += 1;
      const url = request.loadedUrl || request.url;

      const jsonLdProducts = extractJsonLdProducts($, url);
      for (const product of jsonLdProducts) {
        await pushProduct(product);
      }
      const listingProducts = extractListingProducts($, url);
      for (const product of listingProducts) {
        await pushProduct(product);
        if (productCount >= options.maxProducts) {
          stopOnMaxProducts(crawler, options);
          return;
        }
      }
      // JSON-LD is authoritative; the DOM heuristic is only a fallback (avoids duplicates
      // with a different, wrongly picked title on the same URL).
      // A page with several product cards is a listing/category page, not one product.
      const isListingPage = listingProducts.length >= 3 && !hasOwnProductDetail($);
      const domProduct = jsonLdProducts.length || isListingPage ? null : extractDomProduct($, url);
      if (domProduct) await pushProduct(domProduct);

      if (productCount >= options.maxProducts) {
        stopOnMaxProducts(crawler, options);
        return;
      }

      // Product detail URLs go to the front of the queue: with a time-limited run the
      // crawler otherwise spent its budget on category/info pages (lutz-jesco.com: 50 pages).
      const transform = (wantProduct) => (req) => {
        try {
          if (shouldSkipUrl(req.url)) return false;
          const score = scoreUrl(req.url);
          if ((score >= 100) !== wantProduct) return false;
          const neutralDiscoveryLimit = Math.min(100, Math.max(20, Math.floor(options.maxPages * 0.2)));
          if (score <= 0 && pageCount > neutralDiscoveryLimit && productCount > 0) return false;
          req.userData.score = score;
          return req;
        } catch {
          return false;
        }
      };
      await enqueueLinks({ strategy: 'same-domain', forefront: true, transformRequestFunction: transform(true) });
      await enqueueLinks({ strategy: 'same-domain', transformRequestFunction: transform(false) });
    },
    failedRequestHandler({ request }) {
      summary.warnings.push(`Failed: ${request.url}`);
    },
  });

  const stopTimer = scheduleTimeBudgetStop(crawler);
  try {
    await crawler.run(startUrls);
  } finally {
    if (stopTimer) clearTimeout(stopTimer);
  }
}

function stopOnMaxProducts(crawler, options) {
  if (summary.stoppedReason) return;
  summary.stoppedReason = 'max_products';
  log.info('maxProducts reached; stopping crawler', { maxProducts: options.maxProducts, pageCount, productCount });
  crawler.stop();
}

function scheduleTimeBudgetStop(crawler) {
  const timeoutAt = Date.parse(process.env.ACTOR_TIMEOUT_AT || process.env.APIFY_TIMEOUT_AT || '');
  if (!Number.isFinite(timeoutAt)) return null;
  // Reserve time for SUMMARY + webhook flush: 10% of the total run time,
  // at least 30 s and at most 180 s (a fixed 180 s ate most of a 300 s run).
  const startedAt = Date.parse(process.env.ACTOR_STARTED_AT || process.env.APIFY_STARTED_AT || '') || Date.now();
  const totalMs = Math.max(0, timeoutAt - startedAt);
  const reserveMs = Math.min(180000, Math.max(30000, Math.round(totalMs * 0.1)));
  const stopInMs = timeoutAt - Date.now() - reserveMs;
  const stop = () => {
    if (summary.stoppedReason) return;
    summary.stoppedReason = 'time_budget';
    const warning = `Time budget reached; stopping crawler ${Math.round(reserveMs / 1000)}s before Actor timeout`;
    summary.warnings.push(warning);
    log.warning(warning, { pageCount, productCount });
    crawler.stop();
  };
  if (stopInMs <= 0) {
    stop();
    return null;
  }
  log.info('Crawler time budget', { stopAt: new Date(Date.now() + stopInMs).toISOString(), reserveSecs: Math.round(reserveMs / 1000) });
  return setTimeout(stop, stopInMs);
}
