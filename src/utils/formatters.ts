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
    // Rows can be objects (keyed by column name) or arrays (positional)
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const rowObj = row as Record<string, unknown>;
      const obj: Record<string, unknown> = {};
      for (const col of result.columns) {
        obj[col.name] = parseValue(rowObj[col.name], col.dataType);
      }
      // Also include any extra keys (e.g. comparison/percent_change columns)
      for (const key of Object.keys(rowObj)) {
        if (!(key in obj)) {
          obj[key] = rowObj[key];
        }
      }
      return obj;
    }
    // Array-based rows (legacy/fallback)
    const arr = row as unknown[];
    const obj: Record<string, unknown> = {};
    result.columns.forEach((col, i) => {
      obj[col.name] = parseValue(arr[i], col.dataType);
    });
    return obj;
  });
}

/**
 * Parse a ShopifyQL cell value based on its dataType.
 */
function parseValue(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return null;

  const dt = dataType.toLowerCase();
  if (dt === "money" || dt === "number" || dt === "float" || dt === "integer" || dt === "percent") {
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
 * Format a number as currency string using the store's currency.
 */
export function formatMoney(amount: unknown, currencyCode = "USD"): string {
  const n = Number(amount) || 0;
  try {
    return n.toLocaleString("en-US", {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    return `${currencyCode} ${n.toFixed(2)}`;
  }
}

/**
 * Format a number with commas.
 */
export function formatNumber(n: unknown): string {
  const num = Number(n) || 0;
  return num.toLocaleString("en-US");
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
