import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';
import * as cheerio from 'cheerio';

const DEFAULTS = {
  maxProducts: 5000,
  maxPages: 1000,
  includeVariants: true,
  useBrowserFallback: false,
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

const BAD_URL_HINTS = [
  '/blog',
  '/hirek',
  '/news',
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

const PRODUCT_CONTAINER_SELECTORS = [
  '[itemscope][itemtype*="Product"]',
  '.product',
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
  '[class*="termek"]',
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

if (!input.startUrl) {
  throw new Error('Missing required input.startUrl');
}

const startUrl = normalizeUrl(input.startUrl);
const origin = new URL(startUrl).origin;
const targetHost = hostKey(startUrl);
const seenProducts = new Set();
let productCount = 0;
let pageCount = 0;
let webhookBatchIndex = 0;
let webhookDeliveredProducts = 0;
let webhookFailedBatches = 0;
const webhookBuffer = [];
const summary = {
  startUrl,
  strategy: null,
  productCount: 0,
  pageCount: 0,
  datasetId: process.env.APIFY_DEFAULT_DATASET_ID || null,
  actorRunId: process.env.APIFY_ACTOR_RUN_ID || null,
  companyId: input.companyId || null,
  jobId: input.jobId || null,
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
    if (key.startsWith('utm_') || ['fbclid', 'gclid', 'yclid'].includes(key)) {
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

function shouldSkipUrl(value) {
  const lower = decodeURIComponent(String(value)).toLowerCase();
  if (!sameDomain(value)) return true;
  if (BAD_URL_HINTS.some((hint) => lower.includes(hint))) return true;
  if (MEDIA_EXTENSIONS.some((ext) => lower.split('?')[0].endsWith(ext))) return true;
  return false;
}

function scoreUrl(value) {
  const lower = decodeURIComponent(String(value)).toLowerCase();
  let score = 0;
  if (PRODUCT_URL_HINTS.some((hint) => lower.includes(hint))) score += 100;
  if (CATEGORY_URL_HINTS.some((hint) => lower.includes(hint))) score += 50;
  if (/\/(?:[^/]+-)?(?:termek|product|modell|model|adatlap|catalog|katalogus)[^/]*$/i.test(lower)) score += 35;
  if (/\/[^/]*\d[^/]*(?:\/)?$/.test(lower)) score += 10;
  if (BAD_URL_HINTS.some((hint) => lower.includes(hint))) score -= 1000;
  return score;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(value) {
  return cleanText(String(value || '').replace(/<[^>]*>/g, ' '));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function firstNonEmpty(...values) {
  return values.map(cleanText).find(Boolean) || '';
}

function truncate(value, max = 2000) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isLikelyXml(text) {
  const head = String(text || '').slice(0, 500).trim().toLowerCase();
  return head.startsWith('<?xml') || head.startsWith('<rss') || head.startsWith('<feed') || head.startsWith('<urlset') || head.startsWith('<sitemapindex');
}

async function fetchText(url, options = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        accept: options.accept || 'text/html,application/xhtml+xml,application/xml,text/xml,*/*',
        'user-agent': 'ProductCatalogCrawler/1.0 (+https://apify.com)',
      },
    });
    if (!response.ok) return null;
    return response.text();
  } catch (error) {
    summary.warnings.push(`Fetch failed: ${url} - ${error.message}`);
    return null;
  }
}

function parsePriceText(value) {
  const text = cleanText(value);
  if (!text) return null;
  const match = text.match(/(?:\d[\d\s.,]*\s?(?:Ft|HUF|EUR|€|USD|\$)|(?:Ft|HUF|EUR|€|USD|\$)\s?\d[\d\s.,]*)/i);
  return match ? cleanText(match[0]) : null;
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
    const response = await fetch(url, {
      headers: {
        accept: 'application/json,text/plain,*/*',
        'user-agent': 'ProductCatalogCrawler/1.0 (+https://apify.com)',
      },
    });
    if (!response.ok) return null;
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
  const price = firstNonEmpty(
    readXmlText($xml, element, ['g\\:price', 'price', 'ar', 'net_price', 'gross_price', 'sale_price']),
  );
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
    name,
    url: link ? new URL(link, sourceUrl).toString() : sourceUrl,
    sku: sku || null,
    price: price || null,
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

function normalizeWooProduct(product, sourceType = 'product') {
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
    name: cleanText(product.name),
    url: product.permalink || null,
    sku: product.sku || null,
    price: priceFromWoo(product.prices),
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
  const key = `${product.url || ''}|${product.sku || ''}|${product.name}|${product.properties?.variation || ''}`;
  if (seenProducts.has(key)) return false;
  if (productCount >= input.maxProducts) return false;
  seenProducts.add(key);
  productCount += 1;
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
  for (let page = 1; productCount < options.maxProducts; page += 1) {
    const url = `${baseUrl}/wp-json/wc/store/v1/products?per_page=100&page=${page}`;
    const products = await fetchJson(url);
    if (!Array.isArray(products) || products.length === 0) break;
    for (const product of products) {
      await pushProduct(normalizeWooProduct(product, 'product'));
      if (productCount >= options.maxProducts) break;
    }
  }

  if (options.includeVariants && productCount < options.maxProducts) {
    for (let page = 1; productCount < options.maxProducts; page += 1) {
      const url = `${baseUrl}/wp-json/wc/store/v1/products?type=variation&per_page=100&page=${page}`;
      const variations = await fetchJson(url);
      if (!Array.isArray(variations) || variations.length === 0) break;
      for (const variation of variations) {
        await pushProduct(normalizeWooProduct(variation, 'variation'));
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
    name: cleanText(product.title),
    url: `${baseUrl}/products/${product.handle}`,
    sku: firstVariant.sku || null,
    price: firstVariant.price || null,
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

          const price = firstNonEmpty(
            offer.price,
            offer.lowPrice && offer.highPrice ? `${offer.lowPrice} - ${offer.highPrice}` : '',
            aggregateOffer.lowPrice && aggregateOffer.highPrice ? `${aggregateOffer.lowPrice} - ${aggregateOffer.highPrice}` : '',
          );
          const currency = valueText(offer.priceCurrency || aggregateOffer.priceCurrency);
          products.push({
            source: 'json_ld',
            sourceType: 'product',
            id: node.sku || node.mpn || null,
            parentId: null,
            name: valueText(node.name),
            url: node.url ? new URL(node.url, url).toString() : url,
            sku: node.sku || node.mpn || null,
            price: price ? `${price}${currency ? ` ${currency}` : ''}` : null,
            currency: currency || null,
            category: valueText(node.category) || null,
            description: truncate(valueText(node.description), 3000),
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
  if (generator.includes('magento') || html.includes('mage/') || html.includes('magento_') || lowerUrl.includes('/catalog/product/view')) return 'magento_html';
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
  const match = text.match(/(?:SKU|Cikksz[áa]m|Term[ée]kk[óo]d|Article(?:\s+no\.?)?)[:\s#-]{1,10}([A-Za-z0-9._/-]{3,80})/i);
  return match ? match[1] : null;
}

function extractCategory($) {
  const breadcrumbs = $('.breadcrumb a, .breadcrumbs a, nav[aria-label*="breadcrumb"] a, [class*="breadcrumb"] a')
    .map((_i, el) => cleanText($(el).text()))
    .get()
    .filter((item) => item && !/^home|főoldal|kezdőlap$/i.test(item));
  return breadcrumbs.length ? breadcrumbs.slice(-2).join(' > ') : null;
}

function extractListingProducts($, url) {
  const products = [];
  const seenCards = new Set();
  const platform = detectPlatform($, url);
  const category = extractCategory($);
  const selectors = [
    '.product-card',
    '.product-item',
    '.product-list-item',
    '.product-grid-item',
    '.card-product',
    '.collection-product',
    '.catalog-product',
    '.termek',
    '[class*="product-card"]',
    '[class*="product_item"]',
    '[class*="product-item"]',
    '[class*="termek"]',
    '[data-product-id]',
    '[data-product]',
  ];

  for (const selector of selectors) {
    $(selector).each((_i, card) => {
      const $card = $(card);
      const text = cleanText($card.text());
      if (!text || text.length < 5) return;

      const linkEl = $card.find('a[href]').toArray()
        .map((el) => ({
          href: $(el).attr('href'),
          text: cleanText($(el).attr('title') || $(el).text()),
        }))
        .filter((item) => item.href && !/^(#|javascript:|mailto:|tel:)/i.test(item.href))
        .sort((a, b) => scoreUrl(new URL(b.href, url).toString()) - scoreUrl(new URL(a.href, url).toString()))[0];

      const title = firstNonEmpty(
        $card.find('[itemprop="name"]').first().attr('content'),
        $card.find('[itemprop="name"]').first().text(),
        $card.find('.product-title, .product-name, .card-title, .title, .name, h2, h3, h4').first().text(),
        linkEl?.text,
      );
      if (!title || title.length > 220) return;

      const productUrl = linkEl?.href ? new URL(linkEl.href, url).toString() : url;
      const key = `${productUrl}|${title}`;
      if (seenCards.has(key)) return;
      seenCards.add(key);

      const image = firstNonEmpty(
        $card.find('img').first().attr('src'),
        $card.find('img').first().attr('data-src'),
        $card.find('img').first().attr('data-original'),
      );
      const price = firstNonEmpty(
        $card.find('[itemprop="price"]').first().attr('content'),
        $card.find('.price, .ar, .termek-ar, .product-price, [class*="price"], [class*="Price"]').first().text(),
        parsePriceText(text),
      );

      products.push({
        source: `${platform}_listing`,
        sourceType: 'product',
        id: $card.attr('data-product-id') || null,
        parentId: null,
        name: title,
        url: productUrl,
        sku: null,
        price: price || null,
        currency: null,
        category,
        description: truncate($card.find('.description, .summary, [class*="desc"]').first().text(), 1000),
        images: image ? normalizeImages(image, url) : [],
        properties: {},
        variants: [],
      });
    });
    if (products.length >= 100) break;
  }

  return products;
}

function extractDomProduct($, url) {
  const title = firstNonEmpty(
    $('[itemprop="name"]').first().attr('content'),
    $('[itemprop="name"]').first().text(),
    $('h1').first().text(),
    $('meta[property="og:title"]').attr('content'),
    $('title').text(),
  );
  const priceText = cleanText(
    $('[itemprop="price"]').first().attr('content')
    || $('[property="product:price:amount"]').first().attr('content')
    || $('.price, .ar, .termek-ar, .product-ar, .product-price, .woocommerce-Price-amount, [class*="price"], [class*="Price"]').first().text(),
  );
  const pageText = cleanText($('body').text()).toLowerCase();
  const platform = detectPlatform($, url);
  const urlScore = scoreUrl(url);
  const hasProductSignals = PRODUCT_TEXT_SIGNALS.some((signal) => pageText.includes(signal));
  const hasProductContainer = PRODUCT_CONTAINER_SELECTORS.some((selector) => $(selector).length > 0);
  if (!title || (!priceText && !hasProductSignals && !hasProductContainer && urlScore < 50)) return null;

  const properties = extractProperties($);
  const sku = inferSku($, properties);
  const description = firstNonEmpty(
    $('meta[name="description"]').attr('content'),
    $('[itemprop="description"]').first().attr('content'),
    $('[itemprop="description"]').first().text(),
    $('.summary, .description, .product-description, .short-description, .product-short-description, [class*="description"]').first().text(),
  );

  return {
    source: platform,
    sourceType: 'product',
    id: null,
    parentId: null,
    name: title,
    url,
    sku,
    price: priceText || parsePriceText(pageText),
    currency: null,
    category: extractCategory($),
    description: truncate(description, 3000),
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

async function parseSitemap(url, depth = 0) {
  if (depth > 2) return [];
  const text = await fetchText(url, { accept: 'application/xml,text/xml,*/*' });
  if (!text || !isLikelyXml(text)) return [];

  const $xml = cheerio.load(text, { xmlMode: true });
  const sitemapUrls = [];
  $xml('sitemap loc').each((_i, el) => sitemapUrls.push(cleanText($xml(el).text())));

  const urls = [];
  $xml('url loc').each((_i, el) => urls.push(cleanText($xml(el).text())));

  for (const childUrl of sitemapUrls.slice(0, 30)) {
    if (!sameDomain(childUrl)) continue;
    urls.push(...await parseSitemap(childUrl, depth + 1));
  }

  return unique(urls);
}

async function seedFromSitemaps(options) {
  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/product-sitemap.xml`,
    `${origin}/product-sitemap1.xml`,
    `${origin}/sitemap-products.xml`,
    `${origin}/sitemap_product.xml`,
    `${origin}/sitemap_products.xml`,
    `${origin}/sitemap-termek.xml`,
    `${origin}/sitemap_termek.xml`,
  ];

  const urls = [];
  for (const url of candidates) {
    if (urls.length >= options.maxPages) break;
    try {
      urls.push(...await parseSitemap(url));
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

async function crawlHtmlFallback(options) {
  const firecrawlSeeds = await seedFromFirecrawlMap(options);
  const sitemapSeeds = await seedFromSitemaps(options);
  const startUrls = [startUrl, ...sitemapSeeds, ...firecrawlSeeds]
    .filter((url) => {
      try {
        return !shouldSkipUrl(url);
      } catch {
        return false;
      }
    })
    .sort((a, b) => scoreUrl(b) - scoreUrl(a))
    .slice(0, Math.min(options.maxPages, 5000));

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: options.maxPages,
    maxConcurrency: 10,
    requestHandlerTimeoutSecs: 60,
    async requestHandler({ $, request, enqueueLinks }) {
      pageCount += 1;
      const url = request.loadedUrl || request.url;

      for (const product of extractJsonLdProducts($, url)) {
        await pushProduct(product);
      }
      for (const product of extractListingProducts($, url)) {
        await pushProduct(product);
        if (productCount >= options.maxProducts) return;
      }
      const domProduct = extractDomProduct($, url);
      if (domProduct) await pushProduct(domProduct);

      if (productCount >= options.maxProducts) return;

      await enqueueLinks({
        strategy: 'same-domain',
        transformRequestFunction(req) {
          try {
            if (shouldSkipUrl(req.url)) return false;
            const score = scoreUrl(req.url);
            const neutralDiscoveryLimit = Math.min(100, Math.max(20, Math.floor(options.maxPages * 0.2)));
            if (score <= 0 && pageCount > neutralDiscoveryLimit && productCount > 0) return false;
            req.userData.score = score;
            return req;
          } catch {
            return false;
          }
        },
      });
    },
    failedRequestHandler({ request }) {
      summary.warnings.push(`Failed: ${request.url}`);
    },
  });

  await crawler.run(startUrls);
}
