# Product Catalog Crawler Actor

This Actor is the recommended replacement for Dify-only scraping workflows.
Dify should start the Actor and return `run_id`, `dataset_id`, and download URLs.
The full catalog is stored in an Apify Dataset, not in Dify workflow variables.

## Strategies

1. WooCommerce Store API
   - `/wp-json/wc/store/v1/products`
   - optional variations via `type=variation`

2. Shopify products API
   - `/products.json`

3. HTML fallback
   - JSON-LD Product extraction
   - common price/title/meta selectors
   - specification tables and definition lists
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
as a custom tool and call the Actor through the Apify API.

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

