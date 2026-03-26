import { z } from "zod";
import { graphql } from "../shopify-client.js";
import { formatNumber, toolResult, toolError } from "../utils/formatters.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface InventoryResponse {
  productVariants: {
    nodes: Array<{
      id: string;
      displayName: string;
      sku: string | null;
      inventoryQuantity: number | null;
      product: { title: string };
    }>;
  };
}

export function registerInventoryStatus(server: McpServer) {
  server.tool(
    "get_inventory_status",
    "Get current stock levels with low-stock and out-of-stock alerts.",
    {
      low_stock_threshold: z.number().optional().describe("Units below which a product is flagged low-stock (default: 10)"),
      include_all: z.boolean().optional().describe("Show all products or only low/out-of-stock (default: false)"),
    },
    async ({ low_stock_threshold, include_all }) => {
      try {
        const threshold = low_stock_threshold ?? 10;
        const queryFilter = include_all ? "" : `, query: "inventory_quantity:<${threshold}"`;

        const gql = `
          query {
            productVariants(first: 250${queryFilter}) {
              nodes {
                id
                displayName
                sku
                inventoryQuantity
                product { title }
              }
            }
          }
        `;

        const data = await graphql<InventoryResponse>(gql);
        const variants = data.productVariants.nodes;

        const outOfStock = variants.filter((v) => (v.inventoryQuantity ?? 0) <= 0);
        const lowStock = variants.filter((v) => {
          const qty = v.inventoryQuantity ?? 0;
          return qty > 0 && qty < threshold;
        });

        const items = variants.map((v) => ({
          product: v.product.title,
          variant: v.displayName,
          sku: v.sku,
          quantity: v.inventoryQuantity,
          status:
            (v.inventoryQuantity ?? 0) <= 0
              ? "out_of_stock"
              : (v.inventoryQuantity ?? 0) < threshold
                ? "low_stock"
                : "in_stock",
        }));

        const summary = include_all
          ? `Inventory: ${formatNumber(variants.length)} variants total. ${outOfStock.length} out of stock, ${lowStock.length} low stock (below ${threshold} units).`
          : `${outOfStock.length} out-of-stock and ${lowStock.length} low-stock variants (threshold: ${threshold} units).${outOfStock.length === 0 && lowStock.length === 0 ? " All products are well-stocked!" : ""}`;

        return toolResult({
          summary,
          data: {
            threshold,
            out_of_stock_count: outOfStock.length,
            low_stock_count: lowStock.length,
            total_variants: variants.length,
            items,
          },
        });
      } catch (err) {
        return toolError((err as Error).message);
      }
    }
  );
}
