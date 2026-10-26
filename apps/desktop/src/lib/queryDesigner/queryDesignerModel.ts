import type { ColumnInfo, DatabaseType, ForeignKeyInfo } from "@/types/database";
import type { DataGridContextFilterMode, GridCellValue } from "@/lib/dataGrid/dataGridSql";
import { filterModeNeedsValue, filterModeUsesList, filterModeUsesRange, parseFilterValue, parseFilterValues } from "@/lib/dataGrid/dataGridColumnFilter";
import { dataGridFilterRowColumnKind, dataGridFilterRowDateParts, isDataGridFilterRowFilterActive, type DataGridFilterRowFilter } from "@/lib/dataGrid/dataGridFilterRow";

export type QueryDesignerJoinType = "inner-join" | "left-join" | "right-join" | "full-outer-join" | "cross-join" | "where-exists" | "where-not-exists";
export type QueryDesignerAggregate = "min" | "max" | "count" | "count-distinct" | "sum" | "avg";

export const QUERY_DESIGNER_JOIN_TYPES: readonly QueryDesignerJoinType[] = ["inner-join", "left-join", "right-join", "full-outer-join", "cross-join", "where-exists", "where-not-exists"];
export const QUERY_DESIGNER_AGGREGATES: readonly QueryDesignerAggregate[] = ["min", "max", "count", "count-distinct", "sum", "avg"];
/** Sort ranks offered in the columns grid (1st..10th). */
export const QUERY_DESIGNER_MAX_SORT_RANK = 10;

export interface QueryDesignerTableColumn {
  name: string;
  dataType: string;
  isPrimaryKey: boolean;
  isNullable: boolean;
}

/** One foreign key of a canvas table, with its column pairs in key order. */
export interface QueryDesignerForeignKey {
  name: string;
  refSchema?: string;
  refTable: string;
  columns: { column: string; refColumn: string }[];
}

export interface QueryDesignerTable {
  designerId: string;
  catalog?: string;
  schema?: string;
  tableName: string;
  alias?: string;
  x: number;
  y: number;
  columns: QueryDesignerTableColumn[];
  foreignKeys: QueryDesignerForeignKey[];
}

export interface QueryDesignerReference {
  designerId: string;
  sourceId: string;
  targetId: string;
  joinType: QueryDesignerJoinType;
  columns: { source: string; target: string }[];
}

/** Same shape as a data grid filter row entry, so both use one filter box (including date presets). */
export type QueryDesignerColumnFilter = DataGridFilterRowFilter;

export interface QueryDesignerColumn {
  /** Owning table, or a standalone id for a custom expression. */
  designerId: string;
  columnName: string;
  customExpression?: string;
  alias?: string;
  isOutput?: boolean;
  isGrouped?: boolean;
  aggregate?: QueryDesignerAggregate;
  /** 0 = unsorted, n / -n = n-th sort key ascending / descending. */
  sortOrder?: number;
  /** Slot 0 is the main filter, slot n the n-th OR filter. */
  filters?: (QueryDesignerColumnFilter | null)[];
  groupFilters?: (QueryDesignerColumnFilter | null)[];
}

export interface QueryDesignerState {
  tables: QueryDesignerTable[];
  references: QueryDesignerReference[];
  columns: QueryDesignerColumn[];
  distinct?: boolean;
  /** Number of extra OR filter slots shown in the columns grid. */
  orFilterCount?: number;
  groupOrFilterCount?: number;
}

export interface QueryDesignerTableSource {
  catalog?: string;
  schema?: string;
  tableName: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export interface QueryDesignerColumnRef {
  designerId: string;
  columnName: string;
}

type IdFactory = () => string;

export function createQueryDesignerState(): QueryDesignerState {
  return { tables: [], references: [], columns: [] };
}

/** Groups per-column FK rows (one row per column pair) into keys. */
export function groupForeignKeys(rows: readonly ForeignKeyInfo[]): QueryDesignerForeignKey[] {
  const byName = new Map<string, QueryDesignerForeignKey>();
  for (const row of rows) {
    const key = `${row.name}\u0000${row.ref_schema ?? ""}\u0000${row.ref_table}`;
    let foreignKey = byName.get(key);
    if (!foreignKey) {
      foreignKey = { name: row.name, refSchema: row.ref_schema ?? undefined, refTable: row.ref_table, columns: [] };
      byName.set(key, foreignKey);
    }
    foreignKey.columns.push({ column: row.column, refColumn: row.ref_column });
  }
  return [...byName.values()];
}

export function designerTableLabel(table: Pick<QueryDesignerTable, "alias" | "tableName">): string {
  return table.alias?.trim() || table.tableName;
}

/** Second and later instances of a table name get `name2`, `name3`… so qualifiers stay unique. */
export function nextTableAlias(tableName: string, tables: readonly QueryDesignerTable[]): string | undefined {
  const used = new Set(tables.map((table) => designerTableLabel(table).toLowerCase()));
  if (!used.has(tableName.toLowerCase())) return undefined;
  let index = 2;
  while (used.has(`${tableName}${index}`.toLowerCase())) index += 1;
  return `${tableName}${index}`;
}

function sameSchema(left: string | undefined, right: string | undefined, fallback: string | undefined): boolean {
  return (left || fallback || "") === (right || fallback || "");
}

function foreignKeyTargets(foreignKey: QueryDesignerForeignKey, from: QueryDesignerTable, to: QueryDesignerTable): boolean {
  return foreignKey.refTable === to.tableName && sameSchema(foreignKey.refSchema, to.schema, from.schema);
}

/** All FK links between two canvas tables, as references from the referencing table. */
function foreignKeyLinks(table: QueryDesignerTable, other: QueryDesignerTable): Omit<QueryDesignerReference, "designerId">[] {
  const links: Omit<QueryDesignerReference, "designerId">[] = [];
  for (const foreignKey of table.foreignKeys) {
    if (foreignKeyTargets(foreignKey, table, other)) links.push({ sourceId: table.designerId, targetId: other.designerId, joinType: "inner-join", columns: foreignKey.columns.map((pair) => ({ source: pair.column, target: pair.refColumn })) });
  }
  if (table === other) return links;
  for (const foreignKey of other.foreignKeys) {
    if (foreignKeyTargets(foreignKey, other, table)) links.push({ sourceId: other.designerId, targetId: table.designerId, joinType: "inner-join", columns: foreignKey.columns.map((pair) => ({ source: pair.column, target: pair.refColumn })) });
  }
  return links;
}

export function toDesignerTable(source: QueryDesignerTableSource, position: { x: number; y: number }, existing: readonly QueryDesignerTable[], createId: IdFactory): QueryDesignerTable {
  return {
    designerId: createId(),
    catalog: source.catalog,
    schema: source.schema,
    tableName: source.tableName,
    alias: nextTableAlias(source.tableName, existing),
    x: position.x,
    y: position.y,
    columns: source.columns.map((column) => ({ name: column.name, dataType: column.data_type, isPrimaryKey: column.is_primary_key, isNullable: column.is_nullable })),
    foreignKeys: groupForeignKeys(source.foreignKeys),
  };
}

/**
 * Adds a table to the canvas. When exactly one foreign key links it to the tables already on the
 * canvas, that key becomes an INNER JOIN, the same shortcut a user would otherwise draw by hand.
 */
export function addDesignerTable(state: QueryDesignerState, source: QueryDesignerTableSource, position: { x: number; y: number }, createId: IdFactory): QueryDesignerState {
  const table = toDesignerTable(source, position, state.tables, createId);
  const links = state.tables.flatMap((other) => foreignKeyLinks(table, other));
  return {
    ...state,
    tables: [...state.tables, table],
    references: links.length === 1 ? [...state.references, { ...links[0], designerId: createId() }] : state.references,
  };
}

/** Adds the table a foreign key points to, next to its referencing table, joined by that key. */
export function addForeignKeyTable(state: QueryDesignerState, fromDesignerId: string, foreignKey: QueryDesignerForeignKey, source: QueryDesignerTableSource, createId: IdFactory): QueryDesignerState {
  const from = state.tables.find((table) => table.designerId === fromDesignerId);
  if (!from) return state;
  const table = toDesignerTable(source, { x: from.x + 320, y: from.y + 40 }, state.tables, createId);
  return {
    ...state,
    tables: [...state.tables, table],
    references: [...state.references, { designerId: createId(), sourceId: from.designerId, targetId: table.designerId, joinType: "inner-join", columns: foreignKey.columns.map((pair) => ({ source: pair.column, target: pair.refColumn })) }],
  };
}

export function removeDesignerTable(state: QueryDesignerState, designerId: string): QueryDesignerState {
  return {
    ...state,
    tables: state.tables.filter((table) => table.designerId !== designerId),
    references: state.references.filter((reference) => reference.sourceId !== designerId && reference.targetId !== designerId),
    columns: state.columns.filter((column) => column.designerId !== designerId),
  };
}

export function moveDesignerTable(state: QueryDesignerState, designerId: string, position: { x: number; y: number }): QueryDesignerState {
  return { ...state, tables: state.tables.map((table) => (table.designerId === designerId ? { ...table, x: position.x, y: position.y } : table)) };
}

export function setDesignerTableAlias(state: QueryDesignerState, designerId: string, alias: string | undefined): QueryDesignerState {
  const value = alias?.trim() || undefined;
  return { ...state, tables: state.tables.map((table) => (table.designerId === designerId ? { ...table, alias: value } : table)) };
}

/**
 * True when the two tables end up in the same FROM tree (joined or EXISTS-linked) without
 * `excludeReferenceId`. Cross-join references do not connect tables.
 */
export function areTablesConnected(state: QueryDesignerState, firstId: string, secondId: string, excludeReferenceId?: string): boolean {
  if (firstId === secondId) return true;
  const visited = new Set([firstId]);
  const queue = [firstId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const reference of state.references) {
      if (reference.designerId === excludeReferenceId || reference.joinType === "cross-join") continue;
      const next = reference.sourceId === current ? reference.targetId : reference.targetId === current ? reference.sourceId : undefined;
      if (!next || visited.has(next)) continue;
      if (next === secondId) return true;
      visited.add(next);
      queue.push(next);
    }
  }
  return false;
}

/** The join type only matters for the reference that actually connects its tables. */
export function canChangeJoinType(state: QueryDesignerState, reference: QueryDesignerReference): boolean {
  return !areTablesConnected(state, reference.sourceId, reference.targetId, reference.designerId);
}

/**
 * Links two columns. A second column pair between the same two tables extends their existing
 * reference; otherwise a new reference is an INNER JOIN, or a CROSS JOIN condition when the tables
 * are already connected through other references.
 */
export function connectDesignerColumns(state: QueryDesignerState, source: QueryDesignerColumnRef, target: QueryDesignerColumnRef, createId: IdFactory): QueryDesignerState {
  if (source.designerId === target.designerId) return state;
  const existing = state.references.find((reference) => (reference.sourceId === source.designerId && reference.targetId === target.designerId) || (reference.sourceId === target.designerId && reference.targetId === source.designerId));
  if (existing) {
    const pair = existing.sourceId === source.designerId ? { source: source.columnName, target: target.columnName } : { source: target.columnName, target: source.columnName };
    if (existing.columns.some((column) => column.source === pair.source && column.target === pair.target)) return state;
    return { ...state, references: state.references.map((reference) => (reference === existing ? { ...reference, columns: [...reference.columns, pair] } : reference)) };
  }
  const joinType: QueryDesignerJoinType = areTablesConnected(state, source.designerId, target.designerId) ? "cross-join" : "inner-join";
  return {
    ...state,
    references: [...state.references, { designerId: createId(), sourceId: source.designerId, targetId: target.designerId, joinType, columns: [{ source: source.columnName, target: target.columnName }] }],
  };
}

export function setReferenceJoinType(state: QueryDesignerState, referenceId: string, joinType: QueryDesignerJoinType): QueryDesignerState {
  return { ...state, references: state.references.map((reference) => (reference.designerId === referenceId ? { ...reference, joinType } : reference)) };
}

export function removeReference(state: QueryDesignerState, referenceId: string): QueryDesignerState {
  return { ...state, references: state.references.filter((reference) => reference.designerId !== referenceId) };
}

function hasFilters(filters: QueryDesignerColumn["filters"]): boolean {
  return !!filters?.some((filter) => !!filter);
}

/** A column row is kept only while it carries a setting; empty rows vanish like unticked columns. */
export function isDesignerColumnUsed(column: QueryDesignerColumn): boolean {
  return !!(column.customExpression !== undefined || column.isOutput || column.isGrouped || column.alias || column.aggregate || column.sortOrder || hasFilters(column.filters) || hasFilters(column.groupFilters));
}

function sameColumn(column: QueryDesignerColumn, ref: QueryDesignerColumnRef): boolean {
  return column.designerId === ref.designerId && column.columnName === ref.columnName;
}

export function findDesignerColumn(state: QueryDesignerState, ref: QueryDesignerColumnRef): QueryDesignerColumn | undefined {
  return state.columns.find((column) => sameColumn(column, ref));
}

/** Patches a column's settings, creating its row on first use and dropping it once it is empty. */
export function updateDesignerColumn(state: QueryDesignerState, ref: QueryDesignerColumnRef, patch: Partial<Omit<QueryDesignerColumn, "designerId" | "columnName">>): QueryDesignerState {
  const existing = findDesignerColumn(state, ref);
  const next: QueryDesignerColumn = { ...(existing ?? { designerId: ref.designerId, columnName: ref.columnName }), ...patch };
  if (existing) {
    return { ...state, columns: isDesignerColumnUsed(next) ? state.columns.map((column) => (column === existing ? next : column)) : state.columns.filter((column) => column !== existing) };
  }
  return isDesignerColumnUsed(next) ? { ...state, columns: [...state.columns, next] } : state;
}

export function removeDesignerColumn(state: QueryDesignerState, ref: QueryDesignerColumnRef): QueryDesignerState {
  return { ...state, columns: state.columns.filter((column) => !sameColumn(column, ref)) };
}

export function moveDesignerColumn(state: QueryDesignerState, ref: QueryDesignerColumnRef, delta: number): QueryDesignerState {
  const index = state.columns.findIndex((column) => sameColumn(column, ref));
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.columns.length) return state;
  const columns = [...state.columns];
  [columns[index], columns[target]] = [columns[target], columns[index]];
  return { ...state, columns };
}

export function addCustomExpressionColumn(state: QueryDesignerState, createId: IdFactory): QueryDesignerState {
  return { ...state, columns: [...state.columns, { designerId: createId(), columnName: "", customExpression: "", isOutput: true }] };
}

/** Clears `slot` from every column's filters and shifts later OR slots down. */
function dropFilterSlot(columns: QueryDesignerColumn[], key: "filters" | "groupFilters", slot: number): QueryDesignerColumn[] {
  return columns
    .map((column) => {
      const filters = column[key];
      if (!filters || filters.length <= slot) return column;
      return { ...column, [key]: filters.filter((_, index) => index !== slot) };
    })
    .filter(isDesignerColumnUsed);
}

export function setOrFilterCount(state: QueryDesignerState, count: number, group = false): QueryDesignerState {
  const key = group ? "groupFilters" : "filters";
  const countKey = group ? "groupOrFilterCount" : "orFilterCount";
  const current = state[countKey] ?? 0;
  const next = Math.max(0, count);
  let columns = state.columns;
  for (let slot = current; slot > next; slot -= 1) columns = dropFilterSlot(columns, key, slot);
  return { ...state, columns, [countKey]: next };
}

export function isGroupedDesign(state: QueryDesignerState): boolean {
  return state.columns.some((column) => column.isGrouped);
}

export function isCompleteDesignerFilter(filter: QueryDesignerColumnFilter | null | undefined): filter is QueryDesignerColumnFilter {
  return isDataGridFilterRowFilterActive(filter ?? undefined);
}

// ---------------------------------------------------------------------------
// Backend request (mirrors crates/dbx-sql-data/src/query_designer_sql.rs)
// ---------------------------------------------------------------------------

export interface QueryDesignerSqlFilter {
  mode: DataGridContextFilterMode;
  value: GridCellValue;
  values?: GridCellValue[];
  endValue?: GridCellValue;
  /** Further predicates on the same column, AND-ed with this one (date ranges). */
  and?: QueryDesignerSqlFilter[];
}

export interface QueryDesignerSqlOptions {
  databaseType?: DatabaseType;
  identifierQuote?: string;
  tables: { designerId: string; catalog?: string; schema?: string; tableName: string; alias?: string; top: number }[];
  references: QueryDesignerReference[];
  columns: {
    designerId: string;
    columnName: string;
    customExpression?: string;
    alias?: string;
    isOutput: boolean;
    isGrouped: boolean;
    aggregate?: QueryDesignerAggregate;
    sortOrder: number;
    filters: (QueryDesignerSqlFilter | null)[];
    groupFilters: (QueryDesignerSqlFilter | null)[];
    columnInfo?: { name: string; data_type: string; is_nullable: boolean; is_primary_key: boolean };
  }[];
  distinct: boolean;
}

function toSqlFilter(filter: QueryDesignerColumnFilter | null | undefined, column: QueryDesignerTableColumn | undefined, databaseType: DatabaseType | undefined): QueryDesignerSqlFilter | null {
  if (!isCompleteDesignerFilter(filter)) return null;
  const columnInfo = column ? { data_type: column.dataType } : undefined;
  const dateParts = dataGridFilterRowDateParts(filter, dataGridFilterRowColumnKind(column?.dataType, databaseType));
  if (dateParts) {
    const [first, ...rest] = dateParts.map((part) => ({ mode: part.mode, value: parseFilterValue(part.rawValue, columnInfo, databaseType) }));
    return rest.length ? { ...first, and: rest } : first;
  }
  const usesList = filterModeUsesList(filter.mode);
  return {
    mode: filter.mode,
    value: !usesList && filterModeNeedsValue(filter.mode) ? parseFilterValue(filter.rawValue, columnInfo, databaseType) : null,
    values: usesList ? parseFilterValues(filter.rawValue, columnInfo, databaseType) : undefined,
    endValue: filterModeUsesRange(filter.mode) ? parseFilterValue(filter.rawEndValue, columnInfo, databaseType) : undefined,
  };
}

/** Slots beyond the visible OR count are ignored, so hidden leftovers never reach the SQL. */
function toSqlFilters(filters: QueryDesignerColumn["filters"], slotCount: number, column: QueryDesignerTableColumn | undefined, databaseType: DatabaseType | undefined) {
  return Array.from({ length: slotCount }, (_, slot) => toSqlFilter(filters?.[slot], column, databaseType));
}

/** `schemaAware: false` drops the schema from table names (it only carries the database name there). */
export function buildQueryDesignerSqlOptions(state: QueryDesignerState, databaseType: DatabaseType | undefined, identifierQuote?: string, schemaAware = true): QueryDesignerSqlOptions {
  const grouped = isGroupedDesign(state);
  return {
    databaseType,
    identifierQuote,
    tables: state.tables.map((table) => ({ designerId: table.designerId, catalog: table.catalog, schema: schemaAware ? table.schema : undefined, tableName: table.tableName, alias: table.alias, top: table.y })),
    references: state.references,
    columns: state.columns.map((column) => {
      const tableColumn = state.tables.find((table) => table.designerId === column.designerId)?.columns.find((candidate) => candidate.name === column.columnName);
      return {
        designerId: column.designerId,
        columnName: column.columnName,
        customExpression: column.customExpression,
        alias: column.alias,
        isOutput: !!column.isOutput,
        isGrouped: !!column.isGrouped,
        aggregate: column.isGrouped ? undefined : column.aggregate,
        sortOrder: column.sortOrder ?? 0,
        filters: toSqlFilters(column.filters, 1 + (state.orFilterCount ?? 0), tableColumn, databaseType),
        groupFilters: grouped ? toSqlFilters(column.groupFilters, 1 + (state.groupOrFilterCount ?? 0), tableColumn, databaseType) : [],
        columnInfo: tableColumn ? { name: tableColumn.name, data_type: tableColumn.dataType, is_nullable: tableColumn.isNullable, is_primary_key: tableColumn.isPrimaryKey } : undefined,
      };
    }),
    distinct: !!state.distinct,
  };
}

/** Filter operators offered per column; labels are shared with the data grid filter builder. */
export const QUERY_DESIGNER_FILTER_MODE_OPTIONS: readonly { value: DataGridContextFilterMode; labelKey: string }[] = [
  { value: "equals", labelKey: "grid.filterBuilderEquals" },
  { value: "not-equals", labelKey: "grid.filterBuilderNotEquals" },
  { value: "like", labelKey: "grid.filterBuilderContains" },
  { value: "not-like", labelKey: "grid.filterBuilderNotContains" },
  { value: "begins-with", labelKey: "grid.filterBuilderBeginsWith" },
  { value: "ends-with", labelKey: "grid.filterBuilderEndsWith" },
  { value: "greater-than", labelKey: "grid.filterBuilderGreaterThan" },
  { value: "greater-than-or-equal", labelKey: "grid.filterBuilderGreaterThanOrEqual" },
  { value: "less-than", labelKey: "grid.filterBuilderLessThan" },
  { value: "less-than-or-equal", labelKey: "grid.filterBuilderLessThanOrEqual" },
  { value: "in", labelKey: "grid.filterBuilderIn" },
  { value: "not-in", labelKey: "grid.filterBuilderNotIn" },
  { value: "between", labelKey: "grid.filterBuilderBetween" },
  { value: "not-between", labelKey: "grid.filterBuilderNotBetween" },
  { value: "is-null", labelKey: "grid.filterBuilderIsNull" },
  { value: "is-not-null", labelKey: "grid.filterBuilderIsNotNull" },
  { value: "is-blank", labelKey: "grid.filterBuilderIsBlank" },
  { value: "is-not-blank", labelKey: "grid.filterBuilderIsNotBlank" },
];
