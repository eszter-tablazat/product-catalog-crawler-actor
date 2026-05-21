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
   - specification tables, definition lists, and parameter blocks
   - sitemap discovery before crawling
   - old PHP catalog pattern discovery, e.g. `product_details.php?id=1`
   - UNAS, ShopRenter, Magento, PrestaShop, OpenCart, Shopware HTML hints
   - catalog products without prices
   - service offering pages as product-like records when `includeServices=true`
   - optional Firecrawl map for better URL discovery

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
  "currency": "HUF",
  "category": "Category",
  "description": "Short description",
  "images": ["https://example.com/image.jpg"],
  "properties": {
    "weight": "3 kg"
  },
  "variants": []
}
```
