import { z } from "zod";
import { runShopifyQL } from "../shopify-client.js";
import { periodToClause, compareToClause, granularityToClause } from "../utils/shopifyql-helpers.js";
import { tableToObjects, formatMoney, formatNumber, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerOrderTrends(server: McpServer) {
  server.tool(
    "get_order_trends",
    "Get daily/weekly/monthly revenue and order count breakdown for trend analysis.",
    {
      period: z.string().optional().describe("Date range (default: last_30d)"),
      granularity: z.enum(["daily", "weekly", "monthly", "quarterly"]).optional().describe("Time granularity (default: daily)"),
      compare_to: z.string().optional().describe("Comparison period: previous_period, previous_year, none (default: none)"),
    },
    async ({ period, granularity, compare_to }) => {
      try {
        const dateClause = periodToClause(period ?? "last_30d");
        const timeClause = granularityToClause(granularity);
        const cmpClause = compareToClause(compare_to);

        const query = `FROM sales SHOW total_sales, orders, average_order_value ${timeClause} ${dateClause} ${cmpClause}`.trim();

        const result = await runShopifyQL(query);
        const rows = tableToObjects(result);

        if (rows.length === 0) {
          return toolResult({
            summary: "No trend data found for the requested period.",
            data: { period: period ?? "last_30d", granularity: granularity ?? "daily", trends: [] },
          });
        }

        const totalSales = rows.reduce((sum, r) => sum + ((r.total_sales as number) ?? 0), 0);
        const totalOrders = rows.reduce((sum, r) => sum + ((r.orders as number) ?? 0), 0);

        const summary = `${granularity ?? "Daily"} trends for ${period ?? "last 30 days"}: ${rows.length} data points. Total: ${formatMoney(totalSales)} from ${formatNumber(totalOrders)} orders.`;

        return toolResult({
          summary,
          data: {
            period: period ?? "last_30d",
            granularity: granularity ?? "daily",
            total_sales: totalSales,
            total_orders: totalOrders,
            trends: rows,
          },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
