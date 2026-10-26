import type { DatabaseType } from "@/types/database";
import type { DataGridColumnInfo, DataGridContextFilterConditionOptions, DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import { filterModeHasCompleteValue, filterModeNeedsValue, filterModeUsesList, filterModeUsesRange, parseFilterValue, parseFilterValues } from "@/lib/dataGrid/dataGridColumnFilter";

/** Relative date ranges offered for date/time columns, in menu order. */
export const DATA_GRID_FILTER_ROW_DATE_PRESET_GROUPS = [
  ["tomorrow", "today", "yesterday"],
  ["next-week", "this-week", "last-week"],
  ["next-month", "this-month", "last-month"],
  ["next-year", "this-year", "last-year"],
] as const;

export type DataGridFilterRowDatePreset = (typeof DATA_GRID_FILTER_ROW_DATE_PRESET_GROUPS)[number][number];

/** One column's entry in the filter row under the grid headers. */
export interface DataGridFilterRowFilter {
  mode: DataGridContextFilterMode;
  rawValue: string;
  rawEndValue: string;
  /** Relative date range ("this week" …), resolved against the current date each time it is applied. */
  preset?: DataGridFilterRowDatePreset;
}

export type DataGridFilterRowFilters = Record<string, DataGridFilterRowFilter>;

export type DataGridFilterRowColumnKind = "text" | "number" | "boolean" | "datetime" | "other";

const NUMBER_TYPE_PARTS = ["int", "integer", "bigint", "smallint", "tinyint", "mediumint", "serial", "bigserial", "number", "numeric", "decimal", "float", "float4", "float8", "double", "real", "money", "int2", "int4", "int8"];
const TEXT_TYPE_PARTS = ["char", "varchar", "nchar", "nvarchar", "text", "ntext", "tinytext", "mediumtext", "longtext", "string", "clob", "nclob", "citext", "uuid", "uniqueidentifier", "json", "jsonb", "xml", "enum", "name", "bpchar", "character", "varchar2", "nvarchar2"];
const DATETIME_TYPE_PARTS = ["date", "time", "timestamp", "timestamptz", "timetz", "datetime", "datetime2", "smalldatetime", "datetimeoffset", "interval", "year"];

/** Coarse column category used to pick the default operator and the operators offered in ⋮. */
export function dataGridFilterRowColumnKind(dataType: string | undefined, databaseType?: DatabaseType): DataGridFilterRowColumnKind {
  const parts = (dataType ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!parts.length) return "other";
  if (parts.some((part) => part === "bool" || part === "boolean" || (part === "bit" && databaseType !== "postgres"))) return "boolean";
  if (parts.some((part) => DATETIME_TYPE_PARTS.includes(part))) return "datetime";
  if (parts.some((part) => NUMBER_TYPE_PARTS.includes(part))) return "number";
  if (parts.some((part) => TEXT_TYPE_PARTS.includes(part))) return "text";
  return "other";
}

/** Typing into an empty box: text-like columns search ("contains"), everything else matches exactly. */
export function defaultDataGridFilterRowMode(kind: DataGridFilterRowColumnKind): DataGridContextFilterMode {
  return kind === "text" || kind === "other" ? "like" : "equals";
}

const TEXT_ONLY_MODES = new Set<DataGridContextFilterMode>(["like", "not-like", "begins-with", "ends-with", "is-blank", "is-not-blank"]);
const ORDERED_MODES = new Set<DataGridContextFilterMode>(["less-than", "less-than-or-equal", "greater-than", "greater-than-or-equal", "between", "not-between"]);

/** Operators that make sense for a column kind (text search is pointless on numbers, ranges on booleans). */
export function dataGridFilterRowModeApplies(mode: DataGridContextFilterMode, kind: DataGridFilterRowColumnKind): boolean {
  if (kind === "boolean") return !TEXT_ONLY_MODES.has(mode) && !ORDERED_MODES.has(mode);
  if (kind === "number" || kind === "datetime") return !TEXT_ONLY_MODES.has(mode);
  return true;
}

export function isDataGridFilterRowFilterActive(filter: DataGridFilterRowFilter | undefined): filter is DataGridFilterRowFilter {
  return !!filter && (!!filter.preset || filterModeHasCompleteValue(filter.mode, filter.rawValue, filter.rawEndValue));
}

export function activeDataGridFilterRowFilters(filters: DataGridFilterRowFilters): DataGridFilterRowFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, filter]) => isDataGridFilterRowFilterActive(filter)));
}

/** Stable signature of what actually filters, so editing an incomplete box does not re-run the query. */
export function dataGridFilterRowSignature(filters: DataGridFilterRowFilters): string {
  const active = activeDataGridFilterRowFilters(filters);
  return JSON.stringify(
    Object.keys(active)
      .sort()
      .map((column) => [column, active[column].preset ?? active[column].mode, active[column].preset ? "" : active[column].rawValue.trim(), !active[column].preset && filterModeUsesRange(active[column].mode) ? active[column].rawEndValue.trim() : ""]),
  );
}

/** Text shown in a box for a value-less operator ("is null", …) so the cell never looks empty while filtering. */
export function dataGridFilterRowDisplaysValue(mode: DataGridContextFilterMode): boolean {
  return filterModeNeedsValue(mode);
}

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

const DATE_ONLY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

export function isDateOnlyFilterValue(value: string): boolean {
  return DATE_ONLY.test(value.trim());
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local calendar date as `YYYY-MM-DD`; ranges always start at midnight, so no time part is needed. */
export function formatDataGridFilterRowDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function nextDay(value: string): string {
  const [, year, month, day] = DATE_ONLY.exec(value.trim())!;
  return formatDataGridFilterRowDate(new Date(Number(year), Number(month) - 1, Number(day) + 1));
}

/** Half-open local range `[start, end)` of a relative preset. Weeks start on Monday. */
export function dataGridFilterRowPresetRange(preset: DataGridFilterRowDatePreset, now = new Date()): { start: Date; end: Date } {
  const [offsetName, unit] = preset.includes("-") ? (preset.split("-") as [string, string]) : [preset, "day"];
  const offset = offsetName === "next" || offsetName === "tomorrow" ? 1 : offsetName === "last" || offsetName === "yesterday" ? -1 : 0;
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  if (unit === "year") return { start: new Date(year + offset, 0, 1), end: new Date(year + offset + 1, 0, 1) };
  if (unit === "month") return { start: new Date(year, month + offset, 1), end: new Date(year, month + offset + 1, 1) };
  if (unit === "week") {
    const monday = day - ((now.getDay() + 6) % 7) + offset * 7;
    return { start: new Date(year, month, monday), end: new Date(year, month, monday + 7) };
  }
  return { start: new Date(year, month, day + offset), end: new Date(year, month, day + offset + 1) };
}

/**
 * Date/time filters that need two comparisons: relative presets, and date-only values
 * that mean a whole day (`= 2026-10-01`, `<= 2026-10-01`, `between … and 2026-10-01`
 * all include that entire day). Returns `undefined` when the filter is a plain predicate.
 */
export function dataGridFilterRowDateParts(filter: DataGridFilterRowFilter, kind: DataGridFilterRowColumnKind, now = new Date()): Array<{ mode: DataGridContextFilterMode; rawValue: string }> | undefined {
  if (kind !== "datetime") return undefined;
  if (filter.preset) {
    const { start, end } = dataGridFilterRowPresetRange(filter.preset, now);
    return [
      { mode: "greater-than-or-equal", rawValue: formatDataGridFilterRowDate(start) },
      { mode: "less-than", rawValue: formatDataGridFilterRowDate(end) },
    ];
  }
  const value = filter.rawValue.trim();
  const endValue = filter.rawEndValue.trim();
  switch (filter.mode) {
    case "equals":
      return isDateOnlyFilterValue(value)
        ? [
            { mode: "greater-than-or-equal", rawValue: value },
            { mode: "less-than", rawValue: nextDay(value) },
          ]
        : undefined;
    case "less-than-or-equal":
      return isDateOnlyFilterValue(value) ? [{ mode: "less-than", rawValue: nextDay(value) }] : undefined;
    case "greater-than":
      return isDateOnlyFilterValue(value) ? [{ mode: "greater-than-or-equal", rawValue: nextDay(value) }] : undefined;
    case "between":
      return isDateOnlyFilterValue(endValue)
        ? [
            { mode: "greater-than-or-equal", rawValue: value },
            { mode: "less-than", rawValue: nextDay(endValue) },
          ]
        : undefined;
    default:
      return undefined;
  }
}

/** Options for the backend predicate builder; values are typed from the column the same way the filter builder does. */
export function dataGridFilterRowConditionOptions(columnName: string, filter: DataGridFilterRowFilter, context: { databaseType?: DatabaseType; identifierQuote?: string; columnInfo?: DataGridColumnInfo }): DataGridContextFilterConditionOptions {
  const usesList = filterModeUsesList(filter.mode);
  return {
    databaseType: context.databaseType,
    identifierQuote: context.identifierQuote,
    columnName,
    columnInfo: context.columnInfo,
    mode: filter.mode,
    value: !usesList && filterModeNeedsValue(filter.mode) ? parseFilterValue(filter.rawValue, context.columnInfo, context.databaseType) : null,
    values: usesList ? parseFilterValues(filter.rawValue, context.columnInfo, context.databaseType) : undefined,
    endValue: filterModeUsesRange(filter.mode) ? parseFilterValue(filter.rawEndValue, context.columnInfo, context.databaseType) : undefined,
  };
}

/** AND of the per-column predicates, each parenthesised so OR/BETWEEN inside a predicate cannot leak. */
export function combineDataGridFilterRowConditions(conditions: readonly (string | undefined)[]): string | undefined {
  const present = conditions.map((condition) => condition?.trim()).filter((condition): condition is string => !!condition);
  if (!present.length) return undefined;
  if (present.length === 1) return present[0];
  return present.map((condition) => `(${condition})`).join(" AND ");
}

/** Multi-line paste turns each non-empty line into one value of an "in" filter. */
export function dataGridFilterRowPastedValues(text: string): string[] | undefined {
  if (!/[\r\n]/.test(text)) return undefined;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines : undefined;
}
