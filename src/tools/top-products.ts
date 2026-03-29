import { z } from "zod";
import { runShopifyQL, getStoreCurrency } from "../shopify-client.js";
import { periodToClause } from "../utils/shopifyql-helpers.js";
import { tableToObjects, formatMoney, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerTopProducts(server: McpServer) {
  server.tool(
    "get_top_products",
    "Get best-performing products ranked by revenue or order count.",
    {
      period: z.string().optional().describe("Date range (default: last_30d)"),
      sort_by: z.enum(["revenue", "orders"]).optional().describe("Sort by 'revenue' or 'orders' (default: revenue)"),
      limit: z.number().optional().describe("Number of products to return (default: 10, max: 50)"),
    },
    async ({ period, sort_by, limit }) => {
      try {
        const dateClause = periodToClause(period ?? "last_30d");
        const orderField = sort_by === "orders" ? "orders" : "total_sales";
        const cap = Math.min(limit ?? 10, 50);

        const query = `FROM sales SHOW product_title, total_sales, orders, average_order_value GROUP BY product_title ${dateClause} ORDER BY ${orderField} DESC LIMIT ${cap}`;

        const [result, currency] = await Promise.all([runShopifyQL(query), getStoreCurrency()]);
        const rows = tableToObjects(result);

        if (rows.length === 0) {
          return toolResult({
            summary: "No product sales data found for the requested period.",
            data: { period: period ?? "last_30d", products: [] },
          });
        }

        const top3 = rows.slice(0, 3).map((r, i) => {
          const title = r.product_title as string;
          const sales = r.total_sales as number;
          return `${i + 1}. ${title} (${formatMoney(sales, currency)})`;
        });

        const summary = `Top ${rows.length} products by ${sort_by === "orders" ? "order count" : "revenue"} (${period ?? "last 30 days"}):\n${top3.join("\n")}${rows.length > 3 ? `\n...and ${rows.length - 3} more` : ""}`;

        return toolResult({
          summary,
          data: { period: period ?? "last_30d", sort_by: sort_by ?? "revenue", products: rows },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
