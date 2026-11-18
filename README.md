# Product Catalog Crawler Actor

This Actor is the recommended replacement for Dify-only scraping workflows.
Dify should start the Actor and return `run_id`, `dataset_id`, and download URLs.
The full catalog is stored in an Apify Dataset, not in Dify workflow variables.

## Strategies

1. XML product feeds
   - if `startUrl` points to a product XML/RSS/Atom feed
   - useful for UNAS/admin export links and price comparison feeds when you have the feed URL

2. WooCommerce Store API
   - `/wp-json/wc/store/v1/products`
   - optional variations via `type=variation`

3. Shopify products API
   - `/products.json`

4. HTML/catalog fallback
   - JSON-LD Product extraction
   - schema.org Product/ProductModel/ProductGroup
   - product listing cards from category/catalog pages
   - common price/title/meta selectors
   - labelled prices such as `Bruttó termék ár`, `Megrendelés szerelés nélkül`, `Kiszállási díj`, and service fees
   - VAT status column for prices: `price_vat_status` = `bruttó`, `nettó`, or `ismeretlen`
   - VAT status is inferred only from API/page hints by default; unknown cases stay `ismeretlen`
   - canonical product grouping: recognized product families get a `canonical` block; the first product seen in the group becomes canonical
   - specification tables, definition lists, and parameter blocks
   - sitemap discovery before crawling
   - old PHP catalog pattern discovery, e.g. `product_details.php?id=1`
   - UNAS, ShopRenter, Magento, PrestaShop, OpenCart, Shopware HTML hints
   - catalog products without prices
   - service offering pages as product-like records when `includeServices=true`
   - optional Firecrawl map for better URL discovery

## Rate limiting

The Actor uses conservative defaults to avoid HTTP 429 responses on smaller
catalog sites: one concurrent request, at most six requests per minute, and a
ten-second delay between requests to the same domain. These values can be
changed with `maxConcurrency`, `maxRequestsPerMinute`,
`sameDomainDelaySecs`, and `maxRequestRetries` in the Actor input.

HTML crawling uses Apify Proxy by default (`proxyMode=auto`). If a website still
returns HTTP 429 because it blocks datacenter IP addresses, use
`proxyMode=residential` and `proxyCountry=HU`. Residential proxy traffic is a
paid Apify service. Set `proxyMode=none` only for sites that do not block the
Actor's direct IP address.

The direct platform/feed discovery stops after the first HTTP 429 and hands the
job to the proxy-enabled HTML crawler instead of spending the run timeout on
repeated direct requests.

## Run locally

```bash
npm install
apify run -i '{
  "startUrl": "https://klimashop.hu",
  "maxProducts": 1000,
  "maxPages": 1000,
  "includeVariants": true
}'
```

## Test

```bash
npm test
```

If `npm` is not available in a local shell, run the same tests with:

```bash
node --test
```

## Deploy

```bash
apify login
apify push
```

Then import `../dify-integration/apify-product-crawler.openapi.yaml` into Dify
as a custom tool and call the Actor through the Apify API. In Apify API URLs, use
the Actor ID or the `username~actor-name` form, for example
`username~product-catalog-crawler`.

For broader HTML discovery, set `FIRECRAWL_API_KEY` as an Apify Actor environment
variable. The Dify workflow does not need to pass this secret in the visible input.

## Send results to an internal database

For production, keep Dify as the starter/status workflow and let the Actor send
products directly to your internal HTTPS endpoint in batches. Set these Actor
environment variables in Apify:

```text
OUTPUT_WEBHOOK_URL=https://your-system.example.com/products/import
OUTPUT_WEBHOOK_API_KEY=your-secret-token
OUTPUT_WEBHOOK_HEADER_NAME=Authorization
OUTPUT_WEBHOOK_AUTH_PREFIX=Bearer
OUTPUT_WEBHOOK_BATCH_SIZE=100
```

Each request is a JSON `POST`:

```json
{
  "event": "products.batch",
  "job": {
    "runId": "apify-run-id",
    "actorId": "apify-actor-id",
    "sourceUrl": "https://example.com",
    "companyId": "optional-internal-company-id",
    "jobId": "optional-internal-job-id"
  },
  "batch": {
    "index": 1,
    "count": 100,
    "totalSoFar": 100,
    "isFinal": false
  },
  "products": []
}
```

The last request uses `"event": "products.final_batch"` and `"isFinal": true`.

## Output

Each dataset item is one normalized product:

```json
{
  "source": "woocommerce",
  "sourceType": "product",
  "name": "Example product",
  "url": "https://example.com/product/example",
  "sku": "ABC-123",
  "price": "123000 HUF",
  "price_vat_status": "bruttó",
  "currency": "HUF",
  "category": "Category",
  "description": "Short description",
  "images": ["https://example.com/image.jpg"],
  "properties": {
    "weight": "3 kg"
  },
  "canonical": {
    "groupKey": "MIDEA|Xtreme Save|split",
    "isCanonical": false,
    "canonicalUrl": "https://example.com/product/midea-mg2x-09-sp",
    "canonicalName": "Midea MG2X-09-SP Xtreme Save oldalfali split (R32, 2,6 kW)"
  },
  "variants": []
}
```

## v1.2.13

- `sameDomainDelaySecs` is applied in-process (pre-navigation hook) instead of
  Crawlee's queue-reclaim mechanism, which on the Apify platform throttled the
  crawl to ~1 page/minute.
- The crawler stops ~3 minutes before the Actor timeout (`ACTOR_TIMEOUT_AT`), so
  `SUMMARY` and the final webhook batch are always written
  (`summary.stoppedReason = "time_budget"`).
- `/attachment/` and `/wp-content/uploads/` URLs are skipped.

## v1.2.14

- Discovery requests to the target domain (feeds, sitemaps, robots.txt,
  WooCommerce/Shopify APIs) use the same Apify Proxy as the HTML crawler
  (`got-scraping` + `proxyConfiguration.newUrl()`), unless `proxyMode=none`.
- The crawler stops as soon as `maxProducts` is reached
  (`summary.stoppedReason = "max_products"`).

## Build

The Actor is built automatically by Apify on every push to `main`
(Source → Build settings → Automatic builds).

## v1.2.18

- Category = full breadcrumb path (e.g. `Telepített gázérzékelők > Gázérzékelő fejek > MSA`),
  without home/generic roots and the product's own name (was: last 2 links only).
- JSON-LD products get the category from the breadcrumb when JSON-LD has none.
- No breadcrumb: category rebuilt from the URL's parent paths, using the site's link text
  (e.g. logisys.hu `/termekek/logipix-rendszer-elemei/...` → `Logipix rendszer elemei`).
- JSON-LD products with empty description fall back to meta description / main content text.
- A page with a JSON-LD product no longer also yields a DOM-heuristic record (removed
  duplicates with wrongly picked titles).
- JSON-LD price `0` is treated as missing (`null`), not "0 HUF".

## v1.2.17

- Faster default pace: `maxRequestsPerMinute` 30 (was 6), `sameDomainDelaySecs` 2 (was 10).
  A 170-page site (sensorcontrol.hu) now finishes in ~6 min instead of ~35 min, so it
  fits the run timeout instead of stopping on `time_budget` with partial data.
- Adaptive slowdown: on HTTP 429/503 from the target the delay doubles (min 5 s, max 30 s)
  for the rest of the run; noted in `SUMMARY.warnings`.

## v1.2.16

- Sequential `product_details.php?id=N` seeding only when at least 2 of ids 1–3
  look like real product pages (visible body text, not meta tags; soft-404s rejected).
  Fixes logisys.hu, where a 404 template's `og:url` produced 300 fake seeds.
- Catalog leaf pages (`/termekek/<category>/<product>`, few child links) with
  ≥150 chars of descriptive text count as products even without price/cart.
- Description falls back to the main content text around the H1.
- Soft-404 pages (title/H1 "404", "nem található", "not found") are never saved as products.

## v1.2.15

- Time-budget reserve is 10% of the Actor timeout (min 30 s, max 180 s)
  instead of a fixed 180 s, so short runs (e.g. 300 s) keep most of their time.
