import { z } from "zod";
import { runShopifyQL } from "../shopify-client.js";
import { toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerRunShopifyQL(server: McpServer) {
  server.tool(
    "run_shopifyql",
    "Run a raw ShopifyQL query for custom analytics not covered by other tools. Example: FROM sales SHOW total_sales, orders TIMESERIES day SINCE -7d",
    {
      query: z.string().describe("Raw ShopifyQL query string"),
    },
    async ({ query }) => {
      try {
        const result = await runShopifyQL(query);

        const summary = result.rows.length === 0
          ? "ShopifyQL query returned no results."
          : `ShopifyQL query returned ${result.rows.length} rows across ${result.columns.length} columns: ${result.columns.map((c) => c.displayName).join(", ")}.`;

        return toolResult({
          summary,
          data: {
            columns: result.columns,
            rows: result.rows,
            row_count: result.rows.length,
          },
        });
      } catch (err) {
        // Return parse errors to the LLM so it can fix and retry
        return toolError((err as Error).message);
      }
    }
  );
}
