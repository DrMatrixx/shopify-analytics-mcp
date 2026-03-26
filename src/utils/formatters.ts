import type { ShopifyQLResult } from "../shopify-client.js";

export interface ToolResponse {
  summary: string;
  data: Record<string, unknown>;
}

/**
 * Convert ShopifyQL tabular result into an array of objects.
 */
export function tableToObjects(
  result: ShopifyQLResult
): Record<string, unknown>[] {
  return result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((col, i) => {
      obj[col.name] = parseValue(row[i], col.dataType);
    });
    return obj;
  });
}

/**
 * Parse a ShopifyQL cell value based on its dataType.
 */
function parseValue(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return null;

  if (dataType === "money" || dataType === "number" || dataType === "float" || dataType === "integer" || dataType === "percent") {
    if (typeof value === "string") {
      // Strip currency symbols, commas, percent signs
      const cleaned = value.replace(/[$€£¥,% ]/g, "");
      const num = Number(cleaned);
      return isNaN(num) ? value : num;
    }
    return value;
  }

  return value;
}

/**
 * Format a number as currency string.
 */
export function formatMoney(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format a number with commas.
 */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Format a percentage with sign.
 */
export function formatPct(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

/**
 * Build the MCP tool return value.
 */
export function toolResult(response: ToolResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
  };
}

/**
 * Build an error return for the MCP tool.
 */
export function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
