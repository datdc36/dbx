import { describe, expect, it } from "vitest";
import {
  combineDataGridFilterSyntaxConditions,
  dataGridFilterRowFilterToExpression,
  dataGridFilterSyntaxBehaviour,
  dataGridFilterSyntaxConditionOptions,
  dataGridFilterSyntaxError,
  dataGridFilterSyntaxMultipleValues,
  dataGridFilterSyntaxValueExpression,
  DataGridFilterSyntaxError,
  parseDataGridFilterSyntax,
  quoteDataGridFilterSyntaxText,
  type DataGridFilterSyntaxBehaviour,
  type DataGridFilterSyntaxGroups,
} from "@/lib/dataGrid/dataGridFilterSyntax";
import { isDataGridFilterRowFilterActive, dataGridFilterRowSignature, type DataGridFilterRowFilter } from "@/lib/dataGrid/dataGridFilterRow";

/** Wednesday 2026-10-28 15:30 local time. */
const NOW = new Date(2026, 9, 28, 15, 30, 0);

function parse(text: string, behaviour: DataGridFilterSyntaxBehaviour): DataGridFilterSyntaxGroups {
  return parseDataGridFilterSyntax(text, behaviour, NOW);
}

/** Groups written compactly: `mode value` per atom, ` & ` inside a group, ` | ` between groups. */
function show(groups: DataGridFilterSyntaxGroups): string {
  return groups.map((group) => group.map((part) => (part.value === null ? part.mode : `${part.mode} ${JSON.stringify(part.value)}`)).join(" & ")).join(" | ");
}

const range = (start: string, end: string) => `greater-than-or-equal ${JSON.stringify(start)} & less-than ${JSON.stringify(end)}`;

describe("data grid filter syntax (DbGate compatible)", () => {
  it.each([
    ["number", "number"],
    ["text", "string"],
    ["other", "string"],
    ["boolean", "logical"],
    ["datetime", "datetime"],
  ] as const)("reads %s columns with the %s behaviour", (kind, behaviour) => {
    expect(dataGridFilterSyntaxBehaviour(kind)).toBe(behaviour);
  });

  describe("text columns", () => {
    it.each([
      ["abc", 'like "abc"'],
      ["  abc  ", 'like "abc"'],
      ["a b", 'like "a" & like "b"'],
      ["a, b", 'like "a" | like "b"'],
      ["^ab, $yz", 'begins-with "ab" | ends-with "yz"'],
      ["+mid", 'like "mid"'],
      ["!^ab", 'not-begins-with "ab"'],
      ["!$yz", 'not-ends-with "yz"'],
      ["~bad", 'not-like "bad"'],
      ['="a b"', 'equals "a b"'],
      ["='it'", 'equals "it"'],
      ["= x", 'equals "x"'],
      ["!=x", 'not-equals "x"'],
      ["<>x", 'not-equals "x"'],
      [">=m <n", 'greater-than-or-equal "m" & less-than "n"'],
      ["<=10", 'less-than-or-equal "10"'],
      ["NULL", "is-null"],
      ["NOT NULL", "is-not-null"],
      ["EMPTY", "is-empty"],
      ["NOT EMPTY", "is-not-empty"],
      ["0xABcd", 'equals "0xABcd"'],
      ["{$$ > 5}", 'sql-template "$$ > 5"'],
      ['"a\\"b\\"c"', 'like "a\\"b\\"c"'],
      ['"tab\\there"', 'like "tab\\there"'],
      ['"\\u0041"', 'like "A"'],
      ["12", 'like "12"'],
      ["'x', 'y'", 'like "x" | like "y"'],
    ])("%s", (text, expected) => {
      expect(show(parse(text, "string"))).toBe(expected);
    });

    // Behaviour that follows from DbGate's grammar rather than from intent.
    it.each([
      // Keywords are upper-case only (except TRUE / FALSE), so lower-case words are searched for.
      ["null", 'like "null"'],
      ["not null", 'like "not" & like "null"'],
      // No word boundaries: a keyword prefix is taken, the rest becomes a second element.
      ["NULLABLE", 'is-null & like "ABLE"'],
      ["NOTNULL", "is-not-null"],
      ["EMPTYX", 'is-empty & like "X"'],
      // Whitespace between elements is optional.
      ["^a^b", 'begins-with "a" & begins-with "b"'],
      ['"a""b"', 'like "a" & like "b"'],
      ["'it''s'", 'like "it" & like "s"'],
      // An odd trailing hex digit is a separate word.
      ["0xABC", 'equals "0xAB" & like "C"'],
      // An operator with nothing after it is itself a word to search for (except ^, which words cannot contain).
      ["$", 'like "$"'],
      ["+", 'like "+"'],
      ["=", 'like "="'],
      [">", 'like ">"'],
      ["a=b", 'like "a=b"'],
      // `{…}` ends at the first `}`.
      ["{a} b", 'sql-template "a" & like "b"'],
      // An empty `{}` is no SQL condition, so it is searched for as text.
      ["{}", 'like "{}"'],
    ])("hidden case %s", (text, expected) => {
      expect(show(parse(text, "string"))).toBe(expected);
    });

    it.each(["^", "^ ", "a,", ",a", "a,,b", '"unterminated', "   ,"])("rejects %j", (text) => {
      expect(() => parse(text, "string")).toThrow(DataGridFilterSyntaxError);
    });
  });

  describe("number columns", () => {
    it.each([
      ["10", 'equals "10"'],
      ["-1.5e3", 'equals "-1.5e3"'],
      [">10 <20", 'greater-than "10" & less-than "20"'],
      [">= 10", 'greater-than-or-equal "10"'],
      ["1,2,3", 'equals "1" | equals "2" | equals "3"'],
      ["=5", 'equals "5"'],
      ["<>5", 'not-equals "5"'],
      ["!=5", 'not-equals "5"'],
      ['"12"', 'equals "12"'],
      ["'12.75'", 'equals "12.75"'],
      ["NULL, >0", 'is-null | greater-than "0"'],
      ["NOT NULL", "is-not-null"],
      ["{$$ % 2 = 0}", 'sql-template "$$ % 2 = 0"'],
      // No word boundaries: leading zeros split into separate numbers, like DbGate.
      ["007", 'equals "0" & equals "0" & equals "7"'],
      [">5<10", 'greater-than "5" & less-than "10"'],
    ])("%s", (text, expected) => {
      expect(show(parse(text, "number"))).toBe(expected);
    });

    it.each(["abc", "1abc", "^1", "EMPTY", "0xAB", ".5", "=", "TRUE", '"abc"', "{}", "{ }"])("rejects %j", (text) => {
      expect(() => parse(text, "number")).toThrow(DataGridFilterSyntaxError);
    });

    it("reports where parsing stopped", () => {
      const error = dataGridFilterSyntaxError(">10 abc", "number");
      expect(error).toBeInstanceOf(DataGridFilterSyntaxError);
      expect(error?.position).toBe(4);
      expect(error?.found).toBe("abc");
      expect(error?.message).toContain("position 5");
      expect(error?.expected).toContain("number");
    });
  });

  describe("logical columns", () => {
    it.each([
      ["TRUE", "equals true"],
      ["true", "equals true"],
      ["False", "equals false"],
      ["1", "equals true"],
      ["0", "equals false"],
      ["true, null", undefined],
      ["TRUE, NULL", "equals true | is-null"],
      ["FALSE, NULL", "equals false | is-null"],
      ["NOT NULL", "is-not-null"],
      ["{$$ IS TRUE}", 'sql-template "$$ IS TRUE"'],
      ["10", "equals true & equals false"],
    ])("%s", (text, expected) => {
      if (expected === undefined) expect(() => parse(text, "logical")).toThrow(DataGridFilterSyntaxError);
      else expect(show(parse(text, "logical"))).toBe(expected);
    });

    it.each(["yes", "2", "=1", "abc"])("rejects %j", (text) => {
      expect(() => parse(text, "logical")).toThrow(DataGridFilterSyntaxError);
    });
  });

  describe("date/time columns", () => {
    it.each([
      ["2024", range("2024-01-01", "2025-01-01")],
      ["2024-05", range("2024-05-01", "2024-06-01")],
      ["2024-12", range("2024-12-01", "2025-01-01")],
      ["2024-5-1", range("2024-05-01", "2024-05-02")],
      ["2024-02-29", range("2024-02-29", "2024-03-01")],
      ["2024-05-01 13:45", range("2024-05-01 13:45:00", "2024-05-01 13:46:00")],
      ["2024-05-01 13:45:10", range("2024-05-01 13:45:10", "2024-05-01 13:45:11")],
      ["2024-05-01T13:45:10", range("2024-05-01 13:45:10", "2024-05-01 13:45:11")],
      ["2024-05-31 23:59:59", range("2024-05-31 23:59:59", "2024-06-01 00:00:00")],
      ["<= 2024-05", 'less-than "2024-06-01"'],
      [">= 2024-05", 'greater-than-or-equal "2024-05-01"'],
      ["< 2024-05", 'less-than "2024-05-01"'],
      ["> 2024-05", 'greater-than-or-equal "2024-06-01"'],
      ["<= 2024", 'less-than "2025-01-01"'],
      [">=2024-01-01 <2024-02-01", 'greater-than-or-equal "2024-01-01" & less-than "2024-02-01"'],
      ["2024-05, 2024-07", `${range("2024-05-01", "2024-06-01")} | ${range("2024-07-01", "2024-08-01")}`],
      ["TODAY", range("2026-10-28", "2026-10-29")],
      ["YESTERDAY", range("2026-10-27", "2026-10-28")],
      ["TOMORROW", range("2026-10-29", "2026-10-30")],
      ["THIS WEEK", range("2026-10-26", "2026-11-02")],
      ["LAST WEEK", range("2026-10-19", "2026-10-26")],
      ["NEXT WEEK", range("2026-11-02", "2026-11-09")],
      ["THIS MONTH", range("2026-10-01", "2026-11-01")],
      ["LAST MONTH", range("2026-09-01", "2026-10-01")],
      ["NEXT MONTH", range("2026-11-01", "2026-12-01")],
      ["THIS YEAR", range("2026-01-01", "2027-01-01")],
      ["LAST YEAR", range("2025-01-01", "2026-01-01")],
      ["NEXT YEAR", range("2027-01-01", "2028-01-01")],
      ["THISWEEK", range("2026-10-26", "2026-11-02")],
      ["NULL", "is-null"],
      ["NOT NULL, TODAY", `is-not-null | ${range("2026-10-28", "2026-10-29")}`],
      ["{$$ > now()}", 'sql-template "$$ > now()"'],
    ])("%s", (text, expected) => {
      expect(show(parse(text, "datetime"))).toBe(expected);
    });

    it.each([
      "today",
      "abc",
      // There is no `=` / `<>` for dates, as in DbGate: a bare date already means "within that period".
      "=2024-05-01",
      "<>2024",
      "2024-13",
      "2024-02-30",
      "2024-05-01 24:00",
      "2024-05-01T13:45",
      "2024-05-01 13:45:10.5",
      "20245",
    ])("rejects %j", (text) => {
      expect(() => parse(text, "datetime")).toThrow(DataGridFilterSyntaxError);
    });

    it("resolves relative dates when the filter is applied", () => {
      expect(show(parseDataGridFilterSyntax("TODAY", "datetime", new Date(2026, 11, 31, 23, 0)))).toBe(range("2026-12-31", "2027-01-01"));
      expect(show(parseDataGridFilterSyntax("TODAY", "datetime", new Date(2027, 0, 1, 0, 30)))).toBe(range("2027-01-01", "2027-01-02"));
    });
  });

  it("blank text is not an error (and filters nothing)", () => {
    expect(dataGridFilterSyntaxError("   ", "number")).toBeUndefined();
    expect(dataGridFilterSyntaxError("", "string")).toBeUndefined();
  });

  it("builds case-insensitive predicate options for every atom", () => {
    const options = dataGridFilterSyntaxConditionOptions(parse("^ab x, NULL", "string"), { databaseType: "postgres", columnName: "name" });
    expect(options).toEqual([
      [
        { databaseType: "postgres", columnName: "name", mode: "begins-with", value: "ab", likeCaseInsensitive: true },
        { databaseType: "postgres", columnName: "name", mode: "like", value: "x", likeCaseInsensitive: true },
      ],
      [{ databaseType: "postgres", columnName: "name", mode: "is-null", value: null, likeCaseInsensitive: true }],
    ]);
  });

  it.each([
    [[["a"]], "a"],
    [[["a", "b"]], "(a) AND (b)"],
    [[["a"], ["b"]], "(a) OR (b)"],
    [[["a", "b"], ["c"]], "((a) AND (b)) OR (c)"],
    [[["a", undefined], [undefined]], "a"],
    [[[undefined]], undefined],
  ] as const)("combines %j", (groups, expected) => {
    expect(combineDataGridFilterSyntaxConditions(groups)).toBe(expected);
  });

  describe("writing expressions", () => {
    it("quotes text so it parses back to the same value", () => {
      for (const text of ['a "b" c', "back\\slash", "line\nbreak", "tab\tx", "^$,'"]) {
        expect(show(parse(`=${quoteDataGridFilterSyntaxText(text)}`, "string"))).toBe(`equals ${JSON.stringify(text)}`);
      }
    });

    it.each([
      [null, "string", "NULL"],
      ["a b", "string", '="a b"'],
      [12, "number", "=12"],
      ["12.50", "number", "=12.50"],
      [true, "logical", "TRUE"],
      [0, "logical", "FALSE"],
      ["2024-05-01 13:45:10", "datetime", "2024-05-01 13:45:10"],
      ["2024-05-01T13:45:10.123Z", "datetime", undefined],
      ["abc", "number", undefined],
    ] as const)("value %j in a %s column", (value, behaviour, expected) => {
      expect(dataGridFilterSyntaxValueExpression(value, behaviour)).toBe(expected);
    });

    it.each([
      ["is", "string", "a\n\nb c\n", '="a", ="b c"'],
      ["is-not", "string", "a\nb", '<>"a" <>"b"'],
      ["contains", "string", "a\nb", '"a", "b"'],
      ["begins", "string", "a\nb", '^"a", ^"b"'],
      ["ends", "string", "a\r\nb", '$"a", $"b"'],
      ["is", "number", "1\n2", "=1, =2"],
      ["is-not", "number", "1\n2", "<>1 <>2"],
      ["is", "datetime", "2024-05-01\n2024-06", "2024-05-01, 2024-06"],
      ["contains", "number", "1\n2", undefined],
      ["is", "string", "\n \n", undefined],
    ] as const)("pasted lines as %s in a %s column", (mode, behaviour, text, expected) => {
      const expression = dataGridFilterSyntaxMultipleValues(mode, text, behaviour);
      expect(expression).toBe(expected);
      if (expression) expect(() => parse(expression, behaviour)).not.toThrow();
    });

    const filter = (mode: DataGridFilterRowFilter["mode"], rawValue = "", rawEndValue = "", extra: Partial<DataGridFilterRowFilter> = {}): DataGridFilterRowFilter => ({ mode, rawValue, rawEndValue, ...extra });

    it.each([
      [filter("like", "ab"), "string", '+"ab"'],
      [filter("not-like", "ab"), "string", '~"ab"'],
      [filter("begins-with", "ab"), "string", '^"ab"'],
      [filter("ends-with", "ab"), "string", '$"ab"'],
      [filter("equals", "a b"), "string", '="a b"'],
      [filter("not-equals", "x"), "string", '<>"x"'],
      [filter("is-null"), "string", "NULL"],
      [filter("is-not-null"), "number", "NOT NULL"],
      [filter("is-blank"), "string", "NULL, EMPTY"],
      [filter("is-not-blank"), "string", "NOT NULL NOT EMPTY"],
      [filter("greater-than", "10"), "number", ">10"],
      [filter("less-than-or-equal", "2024-05"), "datetime", "<=2024-05"],
      [filter("in", "1, 2, null"), "number", "=1, =2, NULL"],
      [filter("not-in", "'a', 'b'"), "string", '<>"a" <>"b"'],
      [filter("between", "1", "5"), "number", ">=1 <=5"],
      [filter("not-between", "1", "5"), "number", "<1, >5"],
      [filter("equals", "true"), "logical", "TRUE"],
      [filter("equals", "2024-05-01"), "datetime", "2024-05-01"],
      [filter("not-equals", "2024-05-01"), "datetime", "<2024-05-01, >2024-05-01"],
      [filter("between", "", "", { preset: "this-week" }), "datetime", "THIS WEEK"],
      [filter("like", "", "", { expression: ">1" }), "number", ">1"],
      [filter("like", "x"), "number", undefined],
      [filter("greater-than", "abc"), "number", undefined],
    ] as const)("value filter %j as a %s expression", (input, behaviour, expected) => {
      const expression = dataGridFilterRowFilterToExpression(input, behaviour);
      expect(expression).toBe(expected);
      if (expression) expect(() => parse(expression, behaviour)).not.toThrow();
    });
  });

  it("typed filters are active when not blank and keyed by their text", () => {
    expect(isDataGridFilterRowFilterActive({ mode: "like", rawValue: "", rawEndValue: "", expression: "  " })).toBe(false);
    expect(isDataGridFilterRowFilterActive({ mode: "like", rawValue: "", rawEndValue: "", expression: "^a" })).toBe(true);
    const a = dataGridFilterRowSignature({ name: { mode: "like", rawValue: "", rawEndValue: "", expression: "^a " } });
    const b = dataGridFilterRowSignature({ name: { mode: "equals", rawValue: "x", rawEndValue: "", expression: "^a" } });
    const c = dataGridFilterRowSignature({ name: { mode: "like", rawValue: "", rawEndValue: "", expression: "^b" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
