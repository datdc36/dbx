import { describe, expect, it } from "vitest";
import {
  activeDataGridFilterRowFilters,
  combineDataGridFilterRowConditions,
  dataGridFilterRowColumnKind,
  dataGridFilterRowConditionOptions,
  dataGridFilterRowDateParts,
  dataGridFilterRowDatePeriod,
  dataGridFilterRowPresetRange,
  formatDataGridFilterRowDate,
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

  describe("date filters", () => {
    // Wednesday 2026-10-28, mid-afternoon local time.
    const now = new Date(2026, 9, 28, 15, 30);
    const range = (preset: Parameters<typeof dataGridFilterRowPresetRange>[0]) => {
      const { start, end } = dataGridFilterRowPresetRange(preset, now);
      return [formatDataGridFilterRowDate(start), formatDataGridFilterRowDate(end)];
    };

    it.each([
      ["today", "2026-10-28", "2026-10-29"],
      ["yesterday", "2026-10-27", "2026-10-28"],
      ["tomorrow", "2026-10-29", "2026-10-30"],
      ["this-week", "2026-10-26", "2026-11-02"],
      ["last-week", "2026-10-19", "2026-10-26"],
      ["next-week", "2026-11-02", "2026-11-09"],
      ["this-month", "2026-10-01", "2026-11-01"],
      ["last-month", "2026-09-01", "2026-10-01"],
      ["next-month", "2026-11-01", "2026-12-01"],
      ["this-year", "2026-01-01", "2027-01-01"],
      ["last-year", "2025-01-01", "2026-01-01"],
      ["next-year", "2027-01-01", "2028-01-01"],
    ] as const)("%s is [%s, %s)", (preset, start, end) => {
      expect(range(preset)).toEqual([start, end]);
    });

    it("weeks start on Monday even when today is Sunday", () => {
      const { start } = dataGridFilterRowPresetRange("this-week", new Date(2026, 10, 1));
      expect(formatDataGridFilterRowDate(start)).toBe("2026-10-26");
    });

    it("turns a preset into a half-open range", () => {
      expect(dataGridFilterRowDateParts({ mode: "between", rawValue: "", rawEndValue: "", preset: "last-month" }, "datetime", now)).toEqual([
        { mode: "greater-than-or-equal", rawValue: "2026-09-01" },
        { mode: "less-than", rawValue: "2026-10-01" },
      ]);
    });

    it("makes date-only values cover the whole day", () => {
      const parts = (mode: "equals" | "less-than-or-equal" | "greater-than" | "between", rawValue: string, rawEndValue = "") => dataGridFilterRowDateParts({ mode, rawValue, rawEndValue }, "datetime", now);
      expect(parts("between", "2026-09-06", "2026-10-01")).toEqual([
        { mode: "greater-than-or-equal", rawValue: "2026-09-06" },
        { mode: "less-than", rawValue: "2026-10-02" },
      ]);
      expect(parts("equals", "2026-12-31")).toEqual([
        { mode: "greater-than-or-equal", rawValue: "2026-12-31" },
        { mode: "less-than", rawValue: "2027-01-01" },
      ]);
      expect(parts("less-than-or-equal", "2026-02-28")).toEqual([{ mode: "less-than", rawValue: "2026-03-01" }]);
      expect(parts("greater-than", "2026-10-01")).toEqual([{ mode: "greater-than-or-equal", rawValue: "2026-10-02" }]);
    });

    it.each([
      ["2026", "2026-01-01", "2027-01-01"],
      ["2026-09", "2026-09-01", "2026-10-01"],
      ["2026-12", "2026-12-01", "2027-01-01"],
      ["2026-09-1", "2026-09-01", "2026-09-02"],
      ["2026-2-28", "2026-02-28", "2026-03-01"],
    ])("reads %s as a period [%s, %s)", (value, start, end) => {
      expect(dataGridFilterRowDatePeriod(value)).toEqual({ start, end });
    });

    it.each(["2026-13", "2026-02-30", "2026-09-01 10:00", "2026-09-01T10:00:00Z", "26", "abc"])("does not treat %s as a period", (value) => {
      expect(dataGridFilterRowDatePeriod(value)).toBeUndefined();
    });

    it("applies periods to every comparison", () => {
      const parts = (mode: "equals" | "less-than" | "greater-than-or-equal" | "between", rawValue: string, rawEndValue = "") => dataGridFilterRowDateParts({ mode, rawValue, rawEndValue }, "datetime", now);
      expect(parts("equals", "2026")).toEqual([
        { mode: "greater-than-or-equal", rawValue: "2026-01-01" },
        { mode: "less-than", rawValue: "2027-01-01" },
      ]);
      expect(parts("equals", "2026-09")).toEqual([
        { mode: "greater-than-or-equal", rawValue: "2026-09-01" },
        { mode: "less-than", rawValue: "2026-10-01" },
      ]);
      expect(parts("less-than", "2026-09")).toEqual([{ mode: "less-than", rawValue: "2026-09-01" }]);
      expect(parts("greater-than-or-equal", "2026-9-1")).toEqual([{ mode: "greater-than-or-equal", rawValue: "2026-09-01" }]);
      expect(parts("between", "2025", "2026-03")).toEqual([
        { mode: "greater-than-or-equal", rawValue: "2025-01-01" },
        { mode: "less-than", rawValue: "2026-04-01" },
      ]);
      expect(parts("between", "2026-09-01 08:00", "2026-10")).toEqual([
        { mode: "greater-than-or-equal", rawValue: "2026-09-01 08:00" },
        { mode: "less-than", rawValue: "2026-11-01" },
      ]);
    });

    it("keeps explicit times and non-date columns as plain predicates", () => {
      expect(dataGridFilterRowDateParts({ mode: "between", rawValue: "2026-09-06 08:00", rawEndValue: "2026-10-01 18:00" }, "datetime", now)).toBeUndefined();
      expect(dataGridFilterRowDateParts({ mode: "equals", rawValue: "2026-10-01", rawEndValue: "" }, "text", now)).toBeUndefined();
    });
  });
});
