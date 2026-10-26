import type { DatabaseType } from "@/types/database";
import type { DataGridColumnInfo, DataGridContextFilterConditionOptions, DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import { filterModeHasCompleteValue, filterModeNeedsValue, filterModeUsesList, filterModeUsesRange, parseFilterValue, parseFilterValues } from "@/lib/dataGrid/dataGridColumnFilter";

/** One column's entry in the filter row under the grid headers. */
export interface DataGridFilterRowFilter {
  mode: DataGridContextFilterMode;
  rawValue: string;
  rawEndValue: string;
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
  return !!filter && filterModeHasCompleteValue(filter.mode, filter.rawValue, filter.rawEndValue);
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
      .map((column) => [column, active[column].mode, active[column].rawValue.trim(), filterModeUsesRange(active[column].mode) ? active[column].rawEndValue.trim() : ""]),
  );
}

/** Text shown in a box for a value-less operator ("is null", …) so the cell never looks empty while filtering. */
export function dataGridFilterRowDisplaysValue(mode: DataGridContextFilterMode): boolean {
  return filterModeNeedsValue(mode);
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
