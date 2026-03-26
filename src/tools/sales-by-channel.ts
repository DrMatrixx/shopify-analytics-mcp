import { z } from "zod";
import { runShopifyQL } from "../shopify-client.js";
import { periodToClause, compareToClause } from "../utils/shopifyql-helpers.js";
import { tableToObjects, formatMoney, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerSalesByChannel(server: McpServer) {
  server.tool(
    "get_sales_by_channel",
    "Get revenue breakdown by sales channel (Online Store, Shop app, POS, etc.).",
    {
      period: z.string().optional().describe("Date range (default: last_30d)"),
      compare_to: z.string().optional().describe("Comparison: previous_period, previous_year, none (default: none)"),
    },
    async ({ period, compare_to }) => {
      try {
        const dateClause = periodToClause(period ?? "last_30d");
        const cmpClause = compareToClause(compare_to);
        const withClause = cmpClause ? "WITH PERCENT_CHANGE" : "";

        const query = `FROM sales SHOW channel, total_sales, orders, average_order_value GROUP BY channel ${dateClause} ${cmpClause} ${withClause} ORDER BY total_sales DESC`.trim();

        const result = await runShopifyQL(query);
        const rows = tableToObjects(result);

        if (rows.length === 0) {
          return toolResult({
            summary: "No channel sales data found for the requested period.",
            data: { channels: [] },
          });
        }

        const channelLines = rows.map((r) => {
          const name = r.channel as string;
          const sales = r.total_sales as number;
          const orders = r.orders as number;
          return `${name}: ${formatMoney(sales)} (${orders} orders)`;
        });

        const summary = `Sales by channel (${period ?? "last 30 days"}):\n${channelLines.join("\n")}`;

        return toolResult({
          summary,
          data: { period: period ?? "last_30d", channels: rows },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
