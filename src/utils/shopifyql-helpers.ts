const NAMED_PERIODS: Record<string, string> = {
  today: "DURING today",
  yesterday: "DURING yesterday",
  last_7d: "SINCE -7d",
  last_30d: "SINCE -30d",
  last_90d: "SINCE -90d",
  this_week: "DURING this_week",
  last_week: "DURING last_week",
  this_month: "DURING this_month",
  last_month: "DURING last_month",
  this_quarter: "DURING this_quarter",
  last_quarter: "DURING last_quarter",
  this_year: "DURING this_year",
  last_year: "DURING last_year",
  last_12m: "SINCE -365d",
};

export function periodToClause(period?: string): string {
  if (!period) return "SINCE -7d";

  const named = NAMED_PERIODS[period];
  if (named) return named;

  // Custom range: YYYY-MM-DD:YYYY-MM-DD
  const rangeMatch = period.match(
    /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/
  );
  if (rangeMatch) {
    return `SINCE ${rangeMatch[1]} UNTIL ${rangeMatch[2]}`;
  }

  // Pass through anything else (e.g. "bfcm2025") as DURING
  return `DURING ${period}`;
}

export function compareToClause(compareTo?: string): string {
  if (!compareTo || compareTo === "none") return "";
  return `COMPARE TO ${compareTo}`;
}

export function granularityToClause(granularity?: string): string {
  const map: Record<string, string> = {
    daily: "TIMESERIES day",
    weekly: "TIMESERIES week",
    monthly: "TIMESERIES month",
    quarterly: "TIMESERIES quarter",
  };
  return map[granularity ?? "daily"] ?? "TIMESERIES day";
}

export function geographyGroupBy(groupBy?: string): string {
  const map: Record<string, string> = {
    country: "billing_country",
    region: "billing_region",
    city: "billing_city",
  };
  return map[groupBy ?? "country"] ?? "billing_country";
}
