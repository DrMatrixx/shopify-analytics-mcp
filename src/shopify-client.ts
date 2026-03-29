import { getAccessToken, getStoreDomain } from "./auth.js";

const API_VERSION = "2026-01";
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number } } };
}

interface ShopifyQLTableData {
  columns: Array<{ name: string; dataType: string; displayName: string }>;
  rows: unknown;
}

interface ShopifyQLResponse {
  shopifyqlQuery: {
    tableData: ShopifyQLTableData | null;
    parseErrors: string[] | null;
  };
}

export interface ShopifyQLResult {
  columns: Array<{ name: string; dataType: string; displayName: string }>;
  rows: unknown[];
}

async function makeRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
  retryCount = 0
): Promise<T> {
  const token = await getAccessToken();
  const store = getStoreDomain();

  const response = await fetch(
    `https://${store}.myshopify.com/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (response.status === 429 && retryCount < MAX_RETRIES) {
    const delay = RETRY_BASE_MS * Math.pow(2, retryCount);
    await new Promise((r) => setTimeout(r, delay));
    return makeRequest<T>(query, variables, retryCount + 1);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Authentication failed (${response.status}). Check your credentials and ensure your app has the required scopes.`
      );
    }
    throw new Error(
      `Shopify API request failed (${response.status}): ${await response.text()}`
    );
  }

  const result = (await response.json()) as GraphQLResponse<T>;

  // Handle throttled responses in the GraphQL body
  if (result.errors?.some((e) => e.extensions?.code === "THROTTLED")) {
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, retryCount);
      await new Promise((r) => setTimeout(r, delay));
      return makeRequest<T>(query, variables, retryCount + 1);
    }
    throw new Error(
      "Shopify API rate limit reached. Try again in a few seconds or use a narrower date range."
    );
  }

  if (result.errors?.length) {
    const messages = result.errors.map((e) => e.message).join("; ");
    if (messages.includes("access") || messages.includes("scope")) {
      throw new Error(
        `Missing required API scope. Go to your app's Versions tab in the Dev Dashboard, add the needed scope, release a new version, and re-approve in your store admin. Error: ${messages}`
      );
    }
    throw new Error(`Shopify GraphQL error: ${messages}`);
  }

  if (!result.data) {
    throw new Error("Shopify API returned no data.");
  }

  return result.data;
}

export async function runShopifyQL(query: string): Promise<ShopifyQLResult> {
  const gqlQuery = `
    query {
      shopifyqlQuery(query: ${JSON.stringify(query)}) {
        tableData {
          columns { name dataType displayName }
          rows
        }
        parseErrors
      }
    }
  `;

  const data = await makeRequest<ShopifyQLResponse>(gqlQuery);
  const { tableData, parseErrors } = data.shopifyqlQuery;

  if (parseErrors && parseErrors.length > 0) {
    throw new Error(
      `ShopifyQL parse error: ${parseErrors.join("; ")}. Check the query syntax and try again.`
    );
  }

  const rows = tableData?.rows as unknown[] | null;
  if (!tableData || !rows || rows.length === 0) {
    return { columns: tableData?.columns ?? [], rows: [] };
  }

  return { columns: tableData.columns, rows };
}

export async function graphql<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  return makeRequest<T>(query, variables);
}

let cachedCurrency: string | null = null;

export async function getStoreCurrency(): Promise<string> {
  if (cachedCurrency) return cachedCurrency;

  try {
    const data = await graphql<{ shop: { currencyCode: string } }>(
      `query { shop { currencyCode } }`
    );
    cachedCurrency = data.shop.currencyCode;
    return cachedCurrency;
  } catch {
    return "USD";
  }
}
