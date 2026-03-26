# Shopify Analytics MCP Server

Ask Claude about your Shopify store — orders, revenue, top products, inventory — for free.

An open-source [MCP](https://modelcontextprotocol.io) server that gives Shopify store owners natural-language analytics through Claude Desktop, Cursor, Claude Code, or any MCP-compatible host. Runs locally via `npx` — no hosting, no server, no recurring cost.

## Quick Start

### 1. Create a Shopify App

1. Go to [dev.shopify.com/dashboard](https://dev.shopify.com/dashboard)
2. **Create App** → **Start from Dev Dashboard** → name it (e.g. "Claude Analytics")
3. **Versions** tab → **Create version** with these scopes:
   - `read_orders`
   - `read_products`
   - `read_customers`
   - `read_inventory`
   - `read_analytics`
   - `read_reports`
4. **Release** the version
5. **Home** → **Install app** → select your store
6. **Settings** → copy your **Client ID** and **Client Secret**

### 2. Connect to Claude Desktop

Open Claude Desktop → **Settings** → **Developer** → **Edit Config** and paste:

```json
{
  "mcpServers": {
    "shopify-analytics": {
      "command": "npx",
      "args": ["-y", "@scooperai/shopify-analytics-mcp"],
      "env": {
        "SHOPIFY_STORE": "your-store-subdomain",
        "SHOPIFY_CLIENT_ID": "your-client-id",
        "SHOPIFY_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

Replace the three values with your own. `SHOPIFY_STORE` is the subdomain from `your-store-subdomain.myshopify.com`.

Restart Claude Desktop. Done.

### Legacy Auth (existing custom apps)

If you have an existing custom app with a `shpat_` access token:

```json
{
  "mcpServers": {
    "shopify-analytics": {
      "command": "npx",
      "args": ["-y", "@scooperai/shopify-analytics-mcp"],
      "env": {
        "SHOPIFY_STORE": "your-store-subdomain",
        "SHOPIFY_ACCESS_TOKEN": "shpat_xxxxx"
      }
    }
  }
}
```

## Available Tools

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `get_sales_summary` | Revenue, orders, AOV with period comparison | "How did we do last week vs the week before?" |
| `get_top_products` | Best sellers by revenue or units | "What are our top 5 products this month?" |
| `get_order_trends` | Daily/weekly/monthly trend breakdown | "Show me revenue trends for the last 90 days" |
| `get_recent_orders` | Latest orders with status and details | "Any big orders come in today?" |
| `get_order_details` | Full details for a specific order | "What happened with order #1042?" |
| `get_customer_insights` | Customer count, top spenders, aggregates | "Who are our top spenders?" |
| `get_inventory_status` | Stock levels, low-stock and out-of-stock alerts | "Are we out of stock on anything?" |
| `get_product_performance` | Deep dive on a specific product or comparison | "How is the Premium Widget doing this quarter?" |
| `get_sales_by_geography` | Revenue by country, region, or city | "Where are our customers coming from?" |
| `get_sales_by_channel` | Revenue by sales channel | "Which sales channels are performing best?" |
| `get_discount_performance` | Discount code usage and effectiveness | "How are our discount codes performing?" |
| `get_refunds_summary` | Refund totals and rates, optionally by product | "What's our refund rate this month?" |
| `search_orders` | Flexible order search with filters | "Show me all refunded orders from last week" |
| `run_shopifyql` | Run any custom ShopifyQL query | "What are sales by day of week for the last quarter?" |

## Example Conversations

**Daily check-in:**
> "How did we do yesterday?"
>
> Yesterday: $1,842 revenue from 12 orders (AOV $153.50). Down 8% vs the day before. Net revenue after refunds/discounts: $1,720.

**Weekly review:**
> "What are our top selling products this week?"
>
> Top 10 products by revenue (this week):
> 1. Premium Widget ($2,450)
> 2. Starter Kit ($1,890)
> 3. Pro Bundle ($1,230)
> ...

**Inventory alert:**
> "Are we running low on anything?"
>
> 3 out-of-stock and 7 low-stock variants (threshold: 10 units).
> Out of stock: Premium Widget - Large, Starter Kit - Blue, ...

**Custom query:**
> "What does our hourly sales pattern look like?"
>
> *(Uses `run_shopifyql` with `FROM sales SHOW total_sales, orders TIMESERIES hour_of_day DURING last_week`)*

**Ad-hoc investigation:**
> "Show me all orders from jane@example.com"
>
> Found 4 orders matching "email:jane@example.com":
> #1089: $245.00 — Jane Doe (PAID, FULFILLED)
> ...

## How It Works

This MCP server uses two Shopify APIs:

- **ShopifyQL** (`shopifyqlQuery`) for all aggregated analytics — sales summaries, trends, top products, geographic breakdowns, channel performance. Shopify does the aggregation server-side and returns tabular data directly.
- **GraphQL Admin API** for entity-level lookups — specific orders, inventory quantities, order search.

Every tool returns a dual-format response:
- `summary` — a human-readable string the LLM can relay directly
- `data` — structured JSON for follow-up analysis

The server is **read-only by design**. No write operations. No creating products, updating orders, or deleting anything. Analytics only.

## Authentication

The server supports two auth methods, detected automatically from environment variables:

| Variables | Method | Notes |
|-----------|--------|-------|
| `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | Client credentials grant | Recommended. Tokens auto-refresh every 24h. |
| `SHOPIFY_ACCESS_TOKEN` | Legacy static token | For existing custom apps with `shpat_` tokens. |

Client credentials grant requires the app and store to be in the **same Shopify organization**. This is the standard setup for merchants querying their own stores.

## Troubleshooting

**"Authentication failed"**
- Verify your Client ID and Client Secret in the Shopify Dev Dashboard under **Settings**.
- Make sure you released a version of the app and installed it on your store.

**"Client credentials auth requires the app and store to be in the same organization"**
- The Dev Dashboard app must be created under the same organization that owns the store. Log into [dev.shopify.com](https://dev.shopify.com) with the same account that manages your store.

**"Missing required API scope"**
- Go to your app's **Versions** tab in the Dev Dashboard, add the missing scope, release a new version, then re-approve in your store admin.

**"ShopifyQL parse error"**
- If using `run_shopifyql`, check your query syntax. The error message from Shopify will describe what went wrong. Claude can usually fix and retry automatically.

**"Shopify API rate limit reached"**
- The server auto-retries with backoff, but if you're hitting limits consistently, try narrower date ranges or fewer concurrent queries.

## Requirements

- Node.js 18+
- A Shopify store with a Dev Dashboard app (or legacy custom app)
- An MCP-compatible host (Claude Desktop, Cursor, Claude Code, etc.)

## Development

```bash
git clone https://github.com/scooperai/shopify-analytics-mcp.git
cd shopify-analytics-mcp
npm install
npm run build
```

To test locally, set the environment variables and run:

```bash
SHOPIFY_STORE=your-store SHOPIFY_CLIENT_ID=xxx SHOPIFY_CLIENT_SECRET=yyy node dist/index.js
```

## License

MIT

---

Built by [Scooper AI](https://scooperai.com). We build custom AI workflows for e-commerce teams. This MCP server is a free taste of what we do.
