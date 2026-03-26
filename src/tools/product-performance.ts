import { z } from "zod";
import { runShopifyQL } from "../shopify-client.js";
import { periodToClause, compareToClause } from "../utils/shopifyql-helpers.js";
import { tableToObjects, formatMoney, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerProductPerformance(server: McpServer) {
  server.tool(
    "get_product_performance",
    "Get detailed analytics for a specific product or compare all products. Shows revenue, units sold, AOV with optional period comparison.",
    {
      product_title: z.string().optional().describe("Product title to filter (partial match). If omitted, returns all products."),
      period: z.string().optional().describe("Date range (default: last_30d)"),
      compare_to: z.string().optional().describe("Comparison: previous_period, previous_year, none (default: none)"),
    },
    async ({ product_title, period, compare_to }) => {
      try {
        const dateClause = periodToClause(period ?? "last_30d");
        const cmpClause = compareToClause(compare_to);
        const withClause = cmpClause ? "WITH PERCENT_CHANGE" : "";
        const whereClause = product_title ? `WHERE product_title LIKE '%${product_title.replace(/'/g, "\\'")}%'` : "";

        const query = `FROM sales SHOW product_title, total_sales, net_sales, orders, average_order_value GROUP BY product_title ${whereClause} ${dateClause} ${cmpClause} ${withClause} ORDER BY total_sales DESC`.trim();

        const result = await runShopifyQL(query);
        const rows = tableToObjects(result);

        if (rows.length === 0) {
          return toolResult({
            summary: product_title
              ? `No sales data found for products matching "${product_title}".`
              : "No product performance data for the requested period.",
            data: { products: [] },
          });
        }

        const topProduct = rows[0];
        const summary = product_title
          ? `Performance for "${product_title}": ${formatMoney(topProduct.total_sales as number)} revenue, ${topProduct.orders} orders (${period ?? "last 30 days"}).`
          : `${rows.length} products found. Top: ${topProduct.product_title} at ${formatMoney(topProduct.total_sales as number)} (${period ?? "last 30 days"}).`;

        return toolResult({
          summary,
          data: { period: period ?? "last_30d", products: rows },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
