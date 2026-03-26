import { z } from "zod";
import { runShopifyQL } from "../shopify-client.js";
import { periodToClause, geographyGroupBy } from "../utils/shopifyql-helpers.js";
import { tableToObjects, formatMoney, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerSalesByGeography(server: McpServer) {
  server.tool(
    "get_sales_by_geography",
    "Get revenue breakdown by country, region, or city.",
    {
      period: z.string().optional().describe("Date range (default: last_30d)"),
      group_by: z.enum(["country", "region", "city"]).optional().describe("Geographic grouping (default: country)"),
      limit: z.number().optional().describe("Max rows (default: 20)"),
    },
    async ({ period, group_by, limit }) => {
      try {
        const dateClause = periodToClause(period ?? "last_30d");
        const geoField = geographyGroupBy(group_by);
        const cap = Math.min(limit ?? 20, 100);

        const query = `FROM sales SHOW ${geoField}, total_sales, orders, average_order_value GROUP BY ${geoField} ${dateClause} ORDER BY total_sales DESC LIMIT ${cap}`;

        const result = await runShopifyQL(query);
        const rows = tableToObjects(result);

        if (rows.length === 0) {
          return toolResult({
            summary: "No geographic sales data found for the requested period.",
            data: { regions: [] },
          });
        }

        const top3 = rows.slice(0, 3).map((r, i) => {
          const name = r[geoField] as string;
          const sales = r.total_sales as number;
          return `${i + 1}. ${name} (${formatMoney(sales)})`;
        });

        const summary = `Sales by ${group_by ?? "country"} (${period ?? "last 30 days"}):\n${top3.join("\n")}${rows.length > 3 ? `\n...and ${rows.length - 3} more` : ""}`;

        return toolResult({
          summary,
          data: { period: period ?? "last_30d", group_by: group_by ?? "country", regions: rows },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
