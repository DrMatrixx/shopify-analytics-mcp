import { z } from "zod";
import { runShopifyQL } from "../shopify-client.js";
import { periodToClause } from "../utils/shopifyql-helpers.js";
import { tableToObjects, formatMoney, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerRefundsSummary(server: McpServer) {
  server.tool(
    "get_refunds_summary",
    "Get refund metrics — total refunds, refund rate, and optionally by product.",
    {
      period: z.string().optional().describe("Date range (default: last_30d)"),
      group_by: z.enum(["none", "product"]).optional().describe("Group refunds by product (default: none)"),
    },
    async ({ period, group_by }) => {
      try {
        const dateClause = periodToClause(period ?? "last_30d");

        if (group_by === "product") {
          const query = `FROM sales SHOW product_title, sales_reversals, units_sold GROUP BY product_title HAVING sales_reversals > 0 ${dateClause} ORDER BY sales_reversals DESC`;

          const result = await runShopifyQL(query);
          const rows = tableToObjects(result);

          if (rows.length === 0) {
            return toolResult({
              summary: "No refunds found for the requested period.",
              data: { refunds_by_product: [] },
            });
          }

          const top = rows[0];
          const summary = `${rows.length} products had refunds (${period ?? "last 30 days"}). Highest: "${top.product_title}" with ${formatMoney(Math.abs(top.sales_reversals as number))} in refunds.`;

          return toolResult({
            summary,
            data: { period: period ?? "last_30d", refunds_by_product: rows },
          });
        }

        // Aggregate refund summary
        const query = `FROM sales SHOW total_sales, net_sales, sales_reversals, orders ${dateClause} WITH TOTALS`;

        const result = await runShopifyQL(query);
        const rows = tableToObjects(result);

        if (rows.length === 0) {
          return toolResult({
            summary: "No sales data found for the requested period.",
            data: {},
          });
        }

        const totals = rows[rows.length - 1];
        const totalSales = (totals.total_sales as number) ?? 0;
        const netSales = (totals.net_sales as number) ?? 0;
        const refunds = Math.abs((totals.sales_reversals as number) ?? 0);
        const refundRate = totalSales > 0 ? (refunds / totalSales) * 100 : 0;

        const summary = `Refund summary (${period ?? "last 30 days"}): ${formatMoney(refunds)} in refunds (${refundRate.toFixed(1)}% of ${formatMoney(totalSales)} total sales). Net sales: ${formatMoney(netSales)}.`;

        return toolResult({
          summary,
          data: {
            period: period ?? "last_30d",
            total_sales: totalSales,
            net_sales: netSales,
            refunds,
            refund_rate_pct: Number(refundRate.toFixed(1)),
          },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
