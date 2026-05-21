import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

const DEFAULTS = {
  maxProducts: 5000,
  maxPages: 1000,
  includeVariants: true,
  useBrowserFallback: false,
};

const PRODUCT_URL_HINTS = [
  '/termek/',
  '/product/',
  '/products/',
  '/p/',
  '/item/',
  '/sku/',
  '/modell/',
  '/model/',
];

const CATEGORY_URL_HINTS = [
  '/termekek/',
  '/termekkategoria/',
  '/category/',
  '/categories/',
  '/kategoria/',
  '/catalog/',
  '/catalogue/',
  '/katalogus/',
  '/shop/',
  '/webshop/',
  '/collections/',
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

if (!input.startUrl) {
  throw new Error('Missing required input.startUrl');
}

const startUrl = normalizeUrl(input.startUrl);
const origin = new URL(startUrl).origin;
const targetHost = hostKey(startUrl);
const seenProducts = new Set();
let productCount = 0;
let pageCount = 0;
const summary = {
  startUrl,
  strategy: null,
  productCount: 0,
  pageCount: 0,
  datasetId: process.env.APIFY_DEFAULT_DATASET_ID || null,
  warnings: [],
};

try {
  const woo = await tryWooCommerce(origin, input);
  if (woo.handled) {
    summary.strategy = 'woocommerce_store_api';
    summary.productCount = productCount;
    await Actor.setValue('SUMMARY', summary);
    await Actor.exit();
  }

  const shopify = await tryShopify(origin, input);
  if (shopify.handled) {
    summary.strategy = 'shopify_products_json';
    summary.productCount = productCount;
    await Actor.setValue('SUMMARY', summary);
    await Actor.exit();
  }

  summary.strategy = 'html_crawl';
  await crawlHtmlFallback(input);
  summary.productCount = productCount;
  summary.pageCount = pageCount;
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
  const response = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      'user-agent': 'ProductCatalogCrawler/1.0 (+https://apify.com)',
    },
  });
  if (!response.ok) return null;
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

function extractJsonLdProducts($, url) {
  const products = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes.flatMap(expandGraph)) {
        if (String(node['@type'] || '').toLowerCase().includes('product')) {
          const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers || {};
          products.push({
            source: 'json_ld',
            sourceType: 'product',
            id: node.sku || node.mpn || null,
            parentId: null,
            name: cleanText(node.name),
            url: node.url ? new URL(node.url, url).toString() : url,
            sku: node.sku || node.mpn || null,
            price: offer.price ? `${offer.price}${offer.priceCurrency ? ` ${offer.priceCurrency}` : ''}` : null,
            currency: offer.priceCurrency || null,
            category: node.category || null,
            description: cleanText(node.description),
            images: normalizeImages(node.image, url),
            properties: {},
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

function expandGraph(node) {
  if (node?.['@graph'] && Array.isArray(node['@graph'])) return node['@graph'];
  return [node];
}

function normalizeImages(value, baseUrl) {
  const images = Array.isArray(value) ? value : value ? [value] : [];
  return images
    .map((item) => (typeof item === 'string' ? item : item?.url))
    .filter(Boolean)
    .map((src) => new URL(src, baseUrl).toString());
}

function extractDomProduct($, url) {
  const title = cleanText($('h1').first().text() || $('[itemprop="name"]').first().text() || $('title').text());
  const priceText = cleanText(
    $('[itemprop="price"]').first().attr('content')
    || $('.price, .product-price, .woocommerce-Price-amount, [class*="price"]').first().text(),
  );
  const pageText = cleanText($('body').text()).toLowerCase();
  const hasProductSignals = /kosar|cart|ajanlat|quote|sku|cikkszam|price|ar|ár/.test(pageText);
  if (!title || (!priceText && !hasProductSignals)) return null;

  const properties = {};
  $('table tr').each((_i, tr) => {
    const cells = $(tr).find('th,td').map((_j, cell) => cleanText($(cell).text())).get();
    if (cells.length >= 2 && cells[0].length <= 80 && cells[1].length <= 300) {
      properties[cells[0]] = cells.slice(1).join(' ');
    }
  });
  $('dl, .specifications, .product-attributes, .woocommerce-product-attributes').find('dt, th').each((_i, label) => {
    const key = cleanText($(label).text());
    const value = cleanText($(label).next('dd,td').text());
    if (key && value && key.length <= 80 && value.length <= 300) properties[key] = value;
  });

  return {
    source: 'html',
    sourceType: 'product',
    id: null,
    parentId: null,
    name: title,
    url,
    sku: properties.SKU || properties.Cikkszam || properties['Cikkszam'] || null,
    price: priceText || null,
    currency: null,
    category: null,
    description: cleanText($('meta[name="description"]').attr('content') || $('.summary, .description, [itemprop="description"]').first().text()).slice(0, 2000),
    images: normalizeImages($('meta[property="og:image"]').attr('content'), url),
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

async function crawlHtmlFallback(options) {
  const firecrawlSeeds = await seedFromFirecrawlMap(options);
  const startUrls = [startUrl, ...firecrawlSeeds]
    .filter((url) => {
      try {
        return !shouldSkipUrl(url);
      } catch {
        return false;
      }
    })
    .sort((a, b) => scoreUrl(b) - scoreUrl(a))
    .slice(0, Math.min(options.maxPages, 1000));

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
      const domProduct = extractDomProduct($, url);
      if (domProduct) await pushProduct(domProduct);

      if (productCount >= options.maxProducts) return;

      await enqueueLinks({
        strategy: 'same-domain',
        transformRequestFunction(req) {
          try {
            if (shouldSkipUrl(req.url)) return false;
            const score = scoreUrl(req.url);
            if (score <= 0 && pageCount > 20) return false;
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
