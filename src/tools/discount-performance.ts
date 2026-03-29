import { z } from "zod";
import { runShopifyQL, getStoreCurrency } from "../shopify-client.js";
import { periodToClause } from "../utils/shopifyql-helpers.js";
import { tableToObjects, formatMoney, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerDiscountPerformance(server: McpServer) {
  server.tool(
    "get_discount_performance",
    "Get performance of discount codes — revenue, orders, and discount amounts.",
    {
      period: z.string().optional().describe("Date range (default: last_30d)"),
      discount_code: z.string().optional().describe("Specific discount code to filter. If omitted, shows all codes."),
    },
    async ({ period, discount_code }) => {
      try {
        const dateClause = periodToClause(period ?? "last_30d");
        const whereClause = discount_code
          ? `WHERE discount_code = '${discount_code.replace(/'/g, "\\'")}'`
          : "";

        const query = `FROM sales SHOW discount_code, total_sales, orders, discounts, average_order_value GROUP BY discount_code ${whereClause} ${dateClause} ORDER BY orders DESC LIMIT 20`.trim();

        const [result, currency] = await Promise.all([runShopifyQL(query), getStoreCurrency()]);
        const rows = tableToObjects(result);

        if (rows.length === 0) {
          return toolResult({
            summary: discount_code
              ? `No data found for discount code "${discount_code}".`
              : "No discount code usage found for the requested period.",
            data: { discounts: [] },
          });
        }

        const top = rows[0];
        const summary = discount_code
          ? `Discount "${discount_code}": ${formatMoney(top.total_sales, currency)} revenue from ${top.orders} orders, ${formatMoney(top.discounts, currency)} in discounts given (${period ?? "last 30 days"}).`
          : `${rows.length} discount codes used (${period ?? "last 30 days"}). Top: "${top.discount_code}" with ${top.orders} orders generating ${formatMoney(top.total_sales, currency)}.`;

        return toolResult({
          summary,
          data: { period: period ?? "last_30d", discounts: rows },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
