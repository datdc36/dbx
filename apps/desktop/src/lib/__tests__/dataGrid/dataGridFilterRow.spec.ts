import { describe, expect, it } from "vitest";
import {
  activeDataGridFilterRowFilters,
  combineDataGridFilterRowConditions,
  dataGridFilterRowColumnKind,
  dataGridFilterRowConditionOptions,
  dataGridFilterRowModeApplies,
  dataGridFilterRowPastedValues,
  dataGridFilterRowSignature,
  defaultDataGridFilterRowMode,
} from "@/lib/dataGrid/dataGridFilterRow";

describe("data grid filter row", () => {
  it.each([
    ["varchar(255)", "text"],
    ["text", "text"],
    ["uuid", "text"],
    ["int4", "number"],
    ["float8", "number"],
    ["numeric(10,2)", "number"],
    ["bool", "boolean"],
    ["timestamptz", "datetime"],
    ["datetime2", "datetime"],
    ["", "other"],
    ["geometry", "other"],
  ] as const)("classifies %s as %s", (dataType, kind) => {
    expect(dataGridFilterRowColumnKind(dataType, "postgres")).toBe(kind);
  });

  it("treats bit as boolean except on postgres", () => {
    expect(dataGridFilterRowColumnKind("bit", "sqlserver")).toBe("boolean");
    expect(dataGridFilterRowColumnKind("bit", "postgres")).toBe("other");
  });

  it("searches text by default and matches other kinds exactly", () => {
    expect(defaultDataGridFilterRowMode("text")).toBe("like");
    expect(defaultDataGridFilterRowMode("other")).toBe("like");
    expect(defaultDataGridFilterRowMode("number")).toBe("equals");
    expect(defaultDataGridFilterRowMode("datetime")).toBe("equals");
  });

  it("offers only operators that fit the column kind", () => {
    expect(dataGridFilterRowModeApplies("like", "number")).toBe(false);
    expect(dataGridFilterRowModeApplies("between", "number")).toBe(true);
    expect(dataGridFilterRowModeApplies("greater-than", "boolean")).toBe(false);
    expect(dataGridFilterRowModeApplies("is-null", "boolean")).toBe(true);
    expect(dataGridFilterRowModeApplies("begins-with", "text")).toBe(true);
  });

  it("keeps only complete filters and ignores incomplete edits in the signature", () => {
    const filters = {
      name: { mode: "like" as const, rawValue: "an", rawEndValue: "" },
      age: { mode: "between" as const, rawValue: "18", rawEndValue: "" },
      deleted: { mode: "is-null" as const, rawValue: "", rawEndValue: "" },
    };
    expect(Object.keys(activeDataGridFilterRowFilters(filters))).toEqual(["name", "deleted"]);
    expect(dataGridFilterRowSignature(filters)).toBe(dataGridFilterRowSignature({ deleted: filters.deleted, name: filters.name }));
    expect(dataGridFilterRowSignature(filters)).not.toBe(dataGridFilterRowSignature({ ...filters, name: { ...filters.name, rawValue: "bo" } }));
  });

  it("types values from the column like the filter builder", () => {
    const options = dataGridFilterRowConditionOptions("age", { mode: "in", rawValue: "1, 2, null", rawEndValue: "" }, { databaseType: "postgres", columnInfo: { name: "age", data_type: "int4", is_nullable: true } });
    expect(options).toMatchObject({ columnName: "age", mode: "in", value: null, values: ["1", "2", null] });
    const range = dataGridFilterRowConditionOptions("age", { mode: "between", rawValue: "1", rawEndValue: "9" }, { databaseType: "postgres", columnInfo: { name: "age", data_type: "int4", is_nullable: true } });
    expect(range).toMatchObject({ value: "1", endValue: "9", values: undefined });
  });

  it("ANDs per-column predicates and parenthesises them", () => {
    expect(combineDataGridFilterRowConditions([])).toBeUndefined();
    expect(combineDataGridFilterRowConditions(["a = 1", undefined, " "])).toBe("a = 1");
    expect(combineDataGridFilterRowConditions(["a = 1", "(b IS NULL OR b IN (1))"])).toBe("(a = 1) AND ((b IS NULL OR b IN (1)))");
  });

  it("turns multi-line paste into values", () => {
    expect(dataGridFilterRowPastedValues("single")).toBeUndefined();
    expect(dataGridFilterRowPastedValues("a\r\n\n b \nc\n")).toEqual(["a", "b", "c"]);
  });
});
