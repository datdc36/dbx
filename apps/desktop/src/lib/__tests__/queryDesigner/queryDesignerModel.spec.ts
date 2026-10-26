import { describe, expect, it } from "vitest";
import type { ColumnInfo, ForeignKeyInfo } from "@/types/database";
import {
  addDesignerTable,
  addForeignKeyTable,
  areTablesConnected,
  buildQueryDesignerSqlOptions,
  canChangeJoinType,
  connectDesignerColumns,
  createQueryDesignerState,
  groupForeignKeys,
  nextTableAlias,
  removeDesignerTable,
  setOrFilterCount,
  updateDesignerColumn,
  type QueryDesignerState,
  type QueryDesignerTableSource,
} from "@/lib/queryDesigner/queryDesignerModel";

function ids() {
  let next = 0;
  return () => `id${++next}`;
}

function column(name: string, dataType = "integer", isPrimaryKey = false): ColumnInfo {
  return { name, data_type: dataType, is_nullable: !isPrimaryKey, column_default: null, is_primary_key: isPrimaryKey, extra: null };
}

function fk(name: string, columnName: string, refTable: string, refColumn = "id"): ForeignKeyInfo {
  return { name, column: columnName, ref_schema: "public", ref_table: refTable, ref_column: refColumn };
}

const customers: QueryDesignerTableSource = { schema: "public", tableName: "customers", columns: [column("id", "integer", true), column("name", "text")], foreignKeys: [] };
const orders: QueryDesignerTableSource = { schema: "public", tableName: "orders", columns: [column("id", "integer", true), column("customer_id"), column("total", "numeric")], foreignKeys: [fk("orders_customer_fk", "customer_id", "customers")] };

describe("query designer model", () => {
  it("groups per-column foreign key rows into keys", () => {
    const keys = groupForeignKeys([fk("pair_fk", "a", "t", "x"), fk("pair_fk", "b", "t", "y"), fk("other_fk", "c", "u")]);
    expect(keys).toEqual([
      {
        name: "pair_fk",
        refSchema: "public",
        refTable: "t",
        columns: [
          { column: "a", refColumn: "x" },
          { column: "b", refColumn: "y" },
        ],
      },
      { name: "other_fk", refSchema: "public", refTable: "u", columns: [{ column: "c", refColumn: "id" }] },
    ]);
  });

  it("aliases repeated tables", () => {
    const createId = ids();
    let state = addDesignerTable(createQueryDesignerState(), customers, { x: 0, y: 0 }, createId);
    expect(nextTableAlias("customers", state.tables)).toBe("customers2");
    state = addDesignerTable(state, customers, { x: 0, y: 0 }, createId);
    expect(state.tables.map((table) => table.alias)).toEqual([undefined, "customers2"]);
    expect(nextTableAlias("customers", state.tables)).toBe("customers3");
  });

  it("joins a dropped table through its single foreign key in either direction", () => {
    const createId = ids();
    const fromParent = addDesignerTable(addDesignerTable(createQueryDesignerState(), customers, { x: 0, y: 0 }, createId), orders, { x: 300, y: 0 }, createId);
    expect(fromParent.references).toEqual([{ designerId: "id3", sourceId: "id2", targetId: "id1", joinType: "inner-join", columns: [{ source: "customer_id", target: "id" }] }]);

    const fromChild = addDesignerTable(addDesignerTable(createQueryDesignerState(), orders, { x: 0, y: 0 }, createId), customers, { x: 300, y: 0 }, createId);
    expect(fromChild.references).toHaveLength(1);
    expect(fromChild.references[0]).toMatchObject({ sourceId: fromChild.tables[0].designerId, targetId: fromChild.tables[1].designerId });
  });

  it("does not guess a join when several foreign keys qualify", () => {
    const createId = ids();
    const twoLinks: QueryDesignerTableSource = { ...orders, tableName: "transfers", foreignKeys: [fk("from_fk", "from_id", "customers"), fk("to_fk", "to_id", "customers")] };
    const state = addDesignerTable(addDesignerTable(createQueryDesignerState(), customers, { x: 0, y: 0 }, createId), twoLinks, { x: 300, y: 0 }, createId);
    expect(state.references).toEqual([]);
  });

  it("adds a referenced table next to its source, joined by the key", () => {
    const createId = ids();
    const base = addDesignerTable(createQueryDesignerState(), orders, { x: 10, y: 20 }, createId);
    const [foreignKey] = base.tables[0].foreignKeys;
    const state = addForeignKeyTable(base, base.tables[0].designerId, foreignKey, customers, createId);
    expect(state.tables[1]).toMatchObject({ tableName: "customers", x: 330, y: 60 });
    expect(state.references[0]).toMatchObject({ sourceId: base.tables[0].designerId, targetId: state.tables[1].designerId, joinType: "inner-join" });
  });

  it("connects columns, extending an existing reference and treating extra links as cross conditions", () => {
    const createId = ids();
    let state: QueryDesignerState = { ...createQueryDesignerState(), tables: [] };
    state = addDesignerTable(state, { ...customers, foreignKeys: [] }, { x: 0, y: 0 }, createId);
    state = addDesignerTable(state, { ...orders, foreignKeys: [] }, { x: 300, y: 0 }, createId);
    state = addDesignerTable(state, { ...orders, tableName: "notes", foreignKeys: [] }, { x: 600, y: 0 }, createId);
    const [a, b, c] = state.tables.map((table) => table.designerId);

    state = connectDesignerColumns(state, { designerId: b, columnName: "customer_id" }, { designerId: a, columnName: "id" }, createId);
    state = connectDesignerColumns(state, { designerId: a, columnName: "name" }, { designerId: b, columnName: "total" }, createId);
    expect(state.references).toHaveLength(1);
    expect(state.references[0].columns).toEqual([
      { source: "customer_id", target: "id" },
      { source: "total", target: "name" },
    ]);

    state = connectDesignerColumns(state, { designerId: c, columnName: "id" }, { designerId: b, columnName: "id" }, createId);
    state = connectDesignerColumns(state, { designerId: c, columnName: "id" }, { designerId: a, columnName: "id" }, createId);
    expect(state.references.map((reference) => reference.joinType)).toEqual(["inner-join", "inner-join", "cross-join"]);
    expect(areTablesConnected(state, a, c)).toBe(true);
    expect(canChangeJoinType(state, state.references[0])).toBe(true);
    expect(canChangeJoinType(state, state.references[2])).toBe(false);
  });

  it("drops column rows once they carry no setting and removes a table with its links", () => {
    const createId = ids();
    let state = addDesignerTable(addDesignerTable(createQueryDesignerState(), customers, { x: 0, y: 0 }, createId), orders, { x: 300, y: 0 }, createId);
    const ref = { designerId: state.tables[0].designerId, columnName: "name" };
    state = updateDesignerColumn(state, ref, { isOutput: true });
    expect(state.columns).toEqual([{ ...ref, isOutput: true }]);
    state = updateDesignerColumn(state, ref, { isOutput: false });
    expect(state.columns).toEqual([]);

    state = updateDesignerColumn(state, ref, { isOutput: true });
    state = removeDesignerTable(state, state.tables[0].designerId);
    expect(state.tables).toHaveLength(1);
    expect(state.references).toEqual([]);
    expect(state.columns).toEqual([]);
  });

  it("removing an OR filter slot shifts later slots down", () => {
    let state: QueryDesignerState = {
      ...createQueryDesignerState(),
      orFilterCount: 2,
      columns: [{ designerId: "t", columnName: "a", filters: [null, { mode: "equals", rawValue: "1", rawEndValue: "" }, { mode: "equals", rawValue: "2", rawEndValue: "" }] }],
    };
    state = setOrFilterCount(state, 1);
    expect(state.orFilterCount).toBe(1);
    expect(state.columns[0].filters).toEqual([null, { mode: "equals", rawValue: "1", rawEndValue: "" }]);
  });

  it("builds backend options with typed filter values and visible slots only", () => {
    const createId = ids();
    let state = addDesignerTable(createQueryDesignerState(), orders, { x: 0, y: 75 }, createId);
    const designerId = state.tables[0].designerId;
    state = updateDesignerColumn(
      state,
      { designerId, columnName: "total" },
      {
        isOutput: true,
        filters: [
          { mode: "greater-than", rawValue: "10", rawEndValue: "" },
          { mode: "equals", rawValue: "hidden", rawEndValue: "" },
        ],
      },
    );
    state = updateDesignerColumn(state, { designerId, columnName: "id" }, { filters: [{ mode: "in", rawValue: "1, 2, null", rawEndValue: "" }] });

    const options = buildQueryDesignerSqlOptions(state, "postgres", undefined, true);
    expect(options.tables).toEqual([{ designerId, catalog: undefined, schema: "public", tableName: "orders", alias: undefined, top: 75 }]);
    expect(options.columns[0].filters).toEqual([{ mode: "greater-than", value: "10", values: undefined, endValue: undefined }]);
    expect(options.columns[1].filters).toEqual([{ mode: "in", value: null, values: ["1", "2", null], endValue: undefined }]);
    expect(options.columns[0].groupFilters).toEqual([]);

    expect(buildQueryDesignerSqlOptions(state, "mysql", undefined, false).tables[0].schema).toBeUndefined();
  });
});
