import { buildDataGridContextFilterCondition, type DataGridContextFilterConditionOptions, type DataGridContextFilterMode, type GridCellValue } from "@/lib/dataGrid/dataGridSql";
import { filterModeNeedsValue, filterModeUsesList, parseFilterValue, parseFilterValues } from "@/lib/dataGrid/dataGridColumnFilter";
import { dataGridFilterRowPresetRange, formatDataGridFilterRowDate, type DataGridFilterRowColumnKind, type DataGridFilterRowDatePreset, type DataGridFilterRowFilter } from "@/lib/dataGrid/dataGridFilterRow";

/*
 * DbGate-compatible typed filter syntax for the filter row (`>10`, `^abc`, `NULL`, `a, b`, `TODAY` …).
 * Behaviour is reimplemented from docs/filter-row-typed-syntax.md; no DbGate code is used.
 *
 *   list    := factor ( "," factor )*      OR of factors
 *   factor  := element ( \s* element )*    AND of elements (whitespace between them is optional)
 *
 * Elements are tried in a fixed order per column behaviour and the first that matches wins, with
 * no word boundaries: `NULLABLE` in a text column is `NULL` followed by `ABLE`, `>5<10` is two
 * comparisons. Keywords are upper-case only, except `TRUE` / `FALSE`.
 */

export type DataGridFilterSyntaxBehaviour = "string" | "number" | "logical" | "datetime";

/** One predicate on the column; a parsed filter is an OR of AND-groups of these. */
export interface DataGridFilterSyntaxAtom {
  mode: DataGridContextFilterMode;
  value: GridCellValue;
}

export type DataGridFilterSyntaxGroups = DataGridFilterSyntaxAtom[][];

export class DataGridFilterSyntaxError extends Error {
  constructor(
    /** 0-based offset where parsing stopped. */
    readonly position: number,
    readonly expected: string[],
    readonly found: string,
  ) {
    super(`Expected ${expected.join(", ")} at position ${position + 1}${found ? `, found "${found}"` : ""}`);
    this.name = "DataGridFilterSyntaxError";
  }
}

export function dataGridFilterSyntaxBehaviour(kind: DataGridFilterRowColumnKind): DataGridFilterSyntaxBehaviour {
  if (kind === "number") return "number";
  if (kind === "boolean") return "logical";
  if (kind === "datetime") return "datetime";
  return "string";
}

interface BehaviourFlags {
  supportEquals?: boolean;
  supportStringInclusion?: boolean;
  supportEmpty?: boolean;
  supportNumberLikeComparison?: boolean;
  supportDatetimeComparison?: boolean;
  supportDatetimeSymbols?: boolean;
  supportNullTesting?: boolean;
  supportBooleanValues?: boolean;
  supportSqlCondition?: boolean;
  allowStringToken?: boolean;
  allowNumberToken?: boolean;
  allowHexString?: boolean;
}

const BEHAVIOUR_FLAGS: Record<DataGridFilterSyntaxBehaviour, BehaviourFlags> = {
  number: { supportEquals: true, supportNumberLikeComparison: true, supportNullTesting: true, supportSqlCondition: true, allowNumberToken: true },
  string: { supportEquals: true, supportStringInclusion: true, supportEmpty: true, supportNumberLikeComparison: true, supportNullTesting: true, supportSqlCondition: true, allowStringToken: true, allowHexString: true },
  logical: { supportBooleanValues: true, supportNullTesting: true, supportSqlCondition: true },
  datetime: { supportNullTesting: true, supportSqlCondition: true, supportDatetimeSymbols: true, supportDatetimeComparison: true },
};

/** What the ⋮ menu offers for a behaviour, mirroring what the parser accepts. */
export function dataGridFilterSyntaxFeatures(behaviour: DataGridFilterSyntaxBehaviour): Readonly<BehaviourFlags> {
  return BEHAVIOUR_FLAGS[behaviour];
}

// ---------------------------------------------------------------------------
// Parser combinators (ordered choice with backtracking; the furthest failure is reported)
// ---------------------------------------------------------------------------

interface ParseState {
  input: string;
  /** Relative dates (`TODAY` …) resolve against this. */
  now: Date;
  furthest: number;
  expected: Set<string>;
}

function parseState(input: string, now = new Date()): ParseState {
  return { input, now, furthest: -1, expected: new Set() };
}

type Result<T> = { ok: true; value: T; end: number } | { ok: false };
type Parser<T> = (state: ParseState, pos: number) => Result<T>;

const FAILED: { ok: false } = { ok: false };

function fail(state: ParseState, pos: number, expected: string): { ok: false } {
  if (pos > state.furthest) {
    state.furthest = pos;
    state.expected = new Set([expected]);
  } else if (pos === state.furthest) {
    state.expected.add(expected);
  }
  return FAILED;
}

function regex(pattern: RegExp, expected: string, group = 0): Parser<string> {
  const sticky = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, "")}y`);
  return (state, pos) => {
    sticky.lastIndex = pos;
    const match = sticky.exec(state.input);
    if (!match) return fail(state, pos, expected);
    return { ok: true, value: match[group] ?? "", end: pos + match[0].length };
  };
}

function literal(text: string): Parser<string> {
  return (state, pos) => (state.input.startsWith(text, pos) ? { ok: true, value: text, end: pos + text.length } : fail(state, pos, `'${text}'`));
}

/** `undefined` from `transform` rejects the match (an impossible date …) as if it had not matched. */
function map<A, B>(parser: Parser<A>, transform: (value: A) => B | undefined, expected?: string): Parser<B> {
  return (state, pos) => {
    const result = parser(state, pos);
    if (!result.ok) return result;
    const value = transform(result.value);
    if (value === undefined) return fail(state, pos, expected ?? "valid value");
    return { ok: true, value, end: result.end };
  };
}

function alt<T>(...parsers: Parser<T>[]): Parser<T> {
  return (state, pos) => {
    for (const parser of parsers) {
      const result = parser(state, pos);
      if (result.ok) return result;
    }
    return FAILED;
  };
}

/** `prefix` then `parser`, keeping the value of `parser`. */
function then<T>(prefix: Parser<unknown>, parser: Parser<T>): Parser<T> {
  return (state, pos) => {
    const first = prefix(state, pos);
    if (!first.ok) return first;
    return parser(state, first.end);
  };
}

const WHITESPACE = /\s*/y;

function skipWhitespace(state: ParseState, pos: number): number {
  WHITESPACE.lastIndex = pos;
  WHITESPACE.exec(state.input);
  return WHITESPACE.lastIndex;
}

/** `parser` followed by optional whitespace. */
function token<T>(parser: Parser<T>): Parser<T> {
  return (state, pos) => {
    const result = parser(state, pos);
    return result.ok ? { ok: true, value: result.value, end: skipWhitespace(state, result.end) } : result;
  };
}

function word(text: string): Parser<string> {
  return token(literal(text));
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Backslash escapes inside quotes: `\n`, `\t`, `\uXXXX`, and `\x` for any other `x` (so `\"`, `\\`). */
function interpretEscapes(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|[^u])/g, (_, escape: string) => {
    if (escape[0] === "u") return String.fromCharCode(parseInt(escape.slice(1), 16));
    return ESCAPES[escape] ?? escape;
  });
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const WHOLE_NUMBER = new RegExp(`^${NUMBER.source}$`);

const doubleQuoted = map(token(regex(/"((?:\\.|.)*?)"/, "quoted string", 1)), interpretEscapes);
const singleQuoted = map(token(regex(/'((?:\\.|.)*?)'/, "quoted string", 1)), interpretEscapes);
const doubleQuotedNumber = token(regex(new RegExp(`"(${NUMBER.source})"`), "quoted number", 1));
const singleQuotedNumber = token(regex(new RegExp(`'(${NUMBER.source})'`), "quoted number", 1));
const number = token(regex(NUMBER, "number"));
/** A bare word: anything but whitespace, `,`, quotes and `^` (which always starts "begins with"). */
const unquotedString = regex(/[^\s^,'"]+/, "text");
const hexString = map(token(regex(/0x((?:[0-9a-fA-F]{2})+)/, "hex string", 1)), (hex) => `0x${hex}`);
const sqlTemplate = map(token(regex(/\{(.*?)\}/, "{SQL condition}", 1)), (sql) => (sql.trim() ? sql : undefined), "{SQL condition}");

// ---------------------------------------------------------------------------
// Dates (always local time; ranges are half-open [start, end))
// ---------------------------------------------------------------------------

interface DateRange {
  start: string;
  end: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateTime(date: Date): string {
  return `${formatDataGridFilterRowDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

type DateUnit = "year" | "month" | "day" | "minute" | "second";

/** The period a date literal names, or `undefined` for impossible dates (2024-02-30, 25:00 …). */
function literalRange(unit: DateUnit, parts: number[]): DateRange | undefined {
  const [year, month = 1, day = 1, hour = 0, minute = 0, second = 0] = parts;
  const start = new Date(year, month - 1, day, hour, minute, second);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day || start.getHours() !== hour || start.getMinutes() !== minute || start.getSeconds() !== second) return undefined;
  const end = new Date(start);
  if (unit === "year") end.setFullYear(year + 1);
  else if (unit === "month") end.setMonth(month);
  else if (unit === "day") end.setDate(day + 1);
  else if (unit === "minute") end.setMinutes(minute + 1);
  else end.setSeconds(second + 1);
  const format = unit === "minute" || unit === "second" ? formatDateTime : formatDataGridFilterRowDate;
  return { start: format(start), end: format(end) };
}

function dateLiteral(pattern: RegExp, unit: DateUnit): Parser<DateRange> {
  return map(regex(pattern, "date"), (text) => literalRange(unit, (text.match(/\d+/g) ?? []).map(Number)), "valid date");
}

/** Most specific first, so `2024-05-01 13:45` is a minute rather than a day followed by junk. */
const dateValue = alt(dateLiteral(/\d{4}-\d\d?-\d\d?(?:\s+|T)\d\d?:\d\d?:\d\d?/, "second"), dateLiteral(/\d{4}-\d\d?-\d\d?\s+\d\d?:\d\d?/, "minute"), dateLiteral(/\d{4}-\d\d?-\d\d?/, "day"), dateLiteral(/\d{4}-\d\d?/, "month"), dateLiteral(/\d{4}/, "year"));

function rangeAtoms(range: DateRange): DataGridFilterSyntaxAtom[] {
  return [
    { mode: "greater-than-or-equal", value: range.start },
    { mode: "less-than", value: range.end },
  ];
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

type Element = Parser<DataGridFilterSyntaxAtom[]>;

function atom(mode: DataGridContextFilterMode, value: GridCellValue = null): DataGridFilterSyntaxAtom[] {
  return [{ mode, value }];
}

function fixed(parser: Parser<unknown>, mode: DataGridContextFilterMode, value: GridCellValue = null): Element {
  return map(parser, () => atom(mode, value));
}

function operator(symbol: string, value: Parser<string>, mode: DataGridContextFilterMode): Element {
  return map(then(word(symbol), value), (text) => atom(mode, text));
}

const RELATIVE_DATES: [string, DataGridFilterRowDatePreset][] = [
  ["TODAY", "today"],
  ["TOMORROW", "tomorrow"],
  ["YESTERDAY", "yesterday"],
  ["LAST WEEK", "last-week"],
  ["THIS WEEK", "this-week"],
  ["NEXT WEEK", "next-week"],
  ["LAST MONTH", "last-month"],
  ["THIS MONTH", "this-month"],
  ["NEXT MONTH", "next-month"],
  ["LAST YEAR", "last-year"],
  ["THIS YEAR", "this-year"],
  ["NEXT YEAR", "next-year"],
];

function relativeDate(keyword: string, preset: DataGridFilterRowDatePreset): Element {
  const words = keyword.split(" ").map(word);
  const parser = words.length === 1 ? words[0] : then(words[0], words[1]);
  return (state, pos) => {
    const result = parser(state, pos);
    if (!result.ok) return result;
    const { start, end } = dataGridFilterRowPresetRange(preset, state.now);
    return { ok: true, value: rangeAtoms({ start: formatDataGridFilterRowDate(start), end: formatDataGridFilterRowDate(end) }), end: result.end };
  };
}

function createParser(behaviour: DataGridFilterSyntaxBehaviour): Parser<DataGridFilterSyntaxGroups> {
  const flags = BEHAVIOUR_FLAGS[behaviour];
  const values: Parser<string>[] = [];
  if (flags.allowStringToken) values.push(doubleQuoted, singleQuoted, unquotedString);
  if (flags.allowNumberToken) values.push(doubleQuotedNumber, singleQuotedNumber, number);
  const value = alt(...values);

  const not = word("NOT");
  const elements: Element[] = [];

  if (flags.supportDatetimeComparison) elements.push(map(dateValue, rangeAtoms));
  if (flags.supportDatetimeSymbols) elements.push(...RELATIVE_DATES.map(([keyword, preset]) => relativeDate(keyword, preset)));
  if (flags.supportDatetimeComparison) {
    // `<=` / `>` take the end of the named period, `>=` / `<` its start: `<= 2024-05` includes May.
    elements.push(
      map(then(word("<="), dateValue), (range) => atom("less-than", range.end)),
      map(then(word(">="), dateValue), (range) => atom("greater-than-or-equal", range.start)),
      map(then(word("<"), dateValue), (range) => atom("less-than", range.start)),
      map(then(word(">"), dateValue), (range) => atom("greater-than-or-equal", range.end)),
    );
  }
  if (flags.supportNullTesting) elements.push(fixed(word("NULL"), "is-null"), fixed(then(not, word("NULL")), "is-not-null"));
  if (flags.supportEquals && values.length) elements.push(operator("=", value, "equals"), operator("!=", value, "not-equals"), operator("<>", value, "not-equals"));
  if (flags.supportSqlCondition) elements.push(map(sqlTemplate, (sql) => atom("sql-template", sql)));
  if ((flags.supportNumberLikeComparison || flags.supportDatetimeComparison) && values.length) {
    elements.push(operator("<=", value, "less-than-or-equal"), operator(">=", value, "greater-than-or-equal"), operator("<", value, "less-than"), operator(">", value, "greater-than"));
  }
  if (flags.supportEmpty) elements.push(fixed(word("EMPTY"), "is-empty"), fixed(then(not, word("EMPTY")), "is-not-empty"));
  if (flags.allowHexString) elements.push(map(hexString, (hex) => atom("equals", hex)));
  if (flags.supportStringInclusion) {
    elements.push(operator("^", value, "begins-with"), operator("$", value, "ends-with"), operator("+", value, "like"), operator("!^", value, "not-begins-with"), operator("!$", value, "not-ends-with"), operator("~", value, "not-like"));
  }
  if (flags.supportBooleanValues) {
    elements.push(fixed(regex(/true/i, "TRUE"), "equals", true), fixed(regex(/false/i, "FALSE"), "equals", false));
    // `1` / `0` only where they cannot be read as a number or a word.
    if (!flags.allowNumberToken && !flags.allowStringToken) elements.push(fixed(word("1"), "equals", true), fixed(word("0"), "equals", false));
  }
  // Last: a bare value searches text columns and matches other columns exactly.
  if (values.length) elements.push(map(value, (text) => atom(flags.allowStringToken ? "like" : "equals", text)));

  const choice = alt(...elements);
  const element: Element = (state, pos) => {
    const result = choice(state, skipWhitespace(state, pos));
    return result.ok ? { ok: true, value: result.value, end: skipWhitespace(state, result.end) } : result;
  };
  const comma = word(",");

  /** Elements up to the next `,` (possibly none); never fails. */
  const factor = (state: ParseState, start: number) => {
    const atoms: DataGridFilterSyntaxAtom[] = [];
    let end = start;
    for (let next = element(state, end); next.ok; next = element(state, end)) {
      atoms.push(...next.value);
      end = next.end;
    }
    return { atoms, start, end };
  };

  return (state, pos) => {
    const factors = [factor(state, pos)];
    for (let separator = comma(state, factors[0].end); separator.ok; separator = comma(state, factors[factors.length - 1].end)) {
      factors.push(factor(state, separator.end));
    }
    const end = factors[factors.length - 1].end;
    if (end < state.input.length) return fail(state, end, "end of filter");
    // An empty alternative (`a,` or `,a`) would match nothing in SQL, so it is an error rather than ignored.
    const empty = factors.find((candidate) => candidate.atoms.length === 0);
    if (empty) {
      state.furthest = -1;
      return fail(state, skipWhitespace(state, empty.start), "filter value");
    }
    return { ok: true, value: factors.map((candidate) => candidate.atoms), end };
  };
}

const parsers = new Map<DataGridFilterSyntaxBehaviour, Parser<DataGridFilterSyntaxGroups>>();

function parserFor(behaviour: DataGridFilterSyntaxBehaviour): Parser<DataGridFilterSyntaxGroups> {
  let parser = parsers.get(behaviour);
  if (!parser) {
    parser = createParser(behaviour);
    parsers.set(behaviour, parser);
  }
  return parser;
}

/**
 * Parses a typed filter into an OR of AND-groups of predicates; throws `DataGridFilterSyntaxError`.
 * Relative dates (`TODAY` …) resolve against `now`, so re-applying a filter tomorrow moves its range.
 */
export function parseDataGridFilterSyntax(text: string, behaviour: DataGridFilterSyntaxBehaviour, now = new Date()): DataGridFilterSyntaxGroups {
  const state = parseState(text, now);
  const result = parserFor(behaviour)(state, 0);
  if (result.ok) return result.value;
  const position = Math.max(state.furthest, 0);
  const found = text.slice(position).match(/^\S{0,12}/)?.[0] ?? "";
  throw new DataGridFilterSyntaxError(position, [...state.expected], found);
}

export function dataGridFilterSyntaxError(text: string, behaviour: DataGridFilterSyntaxBehaviour): DataGridFilterSyntaxError | undefined {
  if (!text.trim()) return undefined;
  try {
    parseDataGridFilterSyntax(text, behaviour);
    return undefined;
  } catch (error) {
    if (error instanceof DataGridFilterSyntaxError) return error;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// SQL building
// ---------------------------------------------------------------------------

/** Backend predicate options for every atom; text matching ignores case where the dialect allows (DbGate uses ILIKE). */
export function dataGridFilterSyntaxConditionOptions(groups: DataGridFilterSyntaxGroups, base: Omit<DataGridContextFilterConditionOptions, "mode" | "value" | "values" | "endValue">): DataGridContextFilterConditionOptions[][] {
  return groups.map((group) => group.map((part) => ({ ...base, mode: part.mode, value: part.value, likeCaseInsensitive: true })));
}

/** AND inside a group, OR between groups; parenthesised so the result can be AND-ed with other columns. */
export function combineDataGridFilterSyntaxConditions(groups: readonly (readonly (string | undefined)[])[]): string | undefined {
  const rendered = groups
    .map((group) => group.map((condition) => condition?.trim()).filter((condition): condition is string => !!condition))
    .filter((group) => group.length > 0)
    .map((group) => (group.length === 1 ? group[0] : group.map((condition) => `(${condition})`).join(" AND ")));
  if (rendered.length <= 1) return rendered[0];
  return rendered.map((sql) => `(${sql})`).join(" OR ");
}

/**
 * The predicate of a typed filter on one column. An expression that no longer parses (restored
 * state, a changed column type) filters nothing, like DbGate skips it.
 */
export async function buildDataGridFilterSyntaxCondition(expression: string, kind: DataGridFilterRowColumnKind, base: Omit<DataGridContextFilterConditionOptions, "mode" | "value" | "values" | "endValue">, now = new Date()): Promise<string | undefined> {
  let groups: DataGridFilterSyntaxGroups;
  try {
    groups = parseDataGridFilterSyntax(expression, dataGridFilterSyntaxBehaviour(kind), now);
  } catch (error) {
    if (error instanceof DataGridFilterSyntaxError) return undefined;
    throw error;
  }
  const options = dataGridFilterSyntaxConditionOptions(groups, base);
  return combineDataGridFilterSyntaxConditions(await Promise.all(options.map((group) => Promise.all(group.map(buildDataGridContextFilterCondition)))));
}

// ---------------------------------------------------------------------------
// Writing expressions (menu snippets, converted filters, pasted lines)
// ---------------------------------------------------------------------------

export function quoteDataGridFilterSyntaxText(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

function isNumberText(text: string): boolean {
  return WHOLE_NUMBER.test(text);
}

const PRESET_KEYWORDS = new Map(RELATIVE_DATES.map(([keyword, preset]) => [preset, keyword]));

/** `value` written as an operand for `behaviour`, or `undefined` when the syntax cannot express it. */
function operand(value: GridCellValue, behaviour: DataGridFilterSyntaxBehaviour): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (behaviour === "number") return isNumberText(text.trim()) ? text.trim() : undefined;
  if (behaviour === "string") return quoteDataGridFilterSyntaxText(text);
  if (behaviour === "datetime") return dateValueText(text);
  return undefined;
}

function dateValueText(text: string): string | undefined {
  const trimmed = text.trim();
  const result = dateValue(parseState(trimmed), 0);
  return result.ok && result.end === trimmed.length ? trimmed : undefined;
}

/** A value picked from the grid as an expression: `="text"`, `=12`, `TRUE`, `NULL`, a date. */
export function dataGridFilterSyntaxValueExpression(value: GridCellValue, behaviour: DataGridFilterSyntaxBehaviour): string | undefined {
  if (value === null || value === undefined) return BEHAVIOUR_FLAGS[behaviour].supportNullTesting ? "NULL" : undefined;
  if (behaviour === "logical") {
    if (value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true") return "TRUE";
    if (value === false || value === 0 || value === "0" || String(value).toLowerCase() === "false") return "FALSE";
    return undefined;
  }
  if (behaviour === "datetime") return operand(value, behaviour);
  const written = operand(value, behaviour);
  return written === undefined ? undefined : `=${written}`;
}

export type DataGridFilterSyntaxMultipleValuesMode = "is" | "is-not" | "contains" | "begins" | "ends";

/** Pasted lines as one expression: any of (`=a, =b`), none of (`<>a <>b`), or contains / begins / ends any of. */
export function dataGridFilterSyntaxMultipleValues(mode: DataGridFilterSyntaxMultipleValuesMode, text: string, behaviour: DataGridFilterSyntaxBehaviour): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return undefined;
  const prefix = { is: "=", "is-not": "<>", contains: "", begins: "^", ends: "$" }[mode];
  const terms = lines.map((line) => {
    if (behaviour === "logical" || behaviour === "datetime") return mode === "is" ? line : undefined;
    if (behaviour === "number" && mode !== "is" && mode !== "is-not") return undefined;
    const written = behaviour === "number" && isNumberText(line) ? line : quoteDataGridFilterSyntaxText(line);
    return `${prefix}${written}`;
  });
  if (terms.some((term) => term === undefined)) return undefined;
  return terms.join(mode === "is-not" ? " " : ", ");
}

/**
 * A value + operator filter written in the typed syntax, so switching the setting keeps filters
 * readable. `undefined` when there is no exact equivalent (the filter still applies as it is).
 */
export function dataGridFilterRowFilterToExpression(filter: DataGridFilterRowFilter, behaviour: DataGridFilterSyntaxBehaviour): string | undefined {
  if (filter.expression !== undefined) return filter.expression;
  if (filter.preset) return PRESET_KEYWORDS.get(filter.preset);
  const flags = BEHAVIOUR_FLAGS[behaviour];
  const columnInfo = { data_type: behaviour === "number" ? "numeric" : behaviour === "logical" ? "boolean" : "" };
  const single = () => (filterModeNeedsValue(filter.mode) && !filterModeUsesList(filter.mode) ? parseFilterValue(filter.rawValue, columnInfo) : null);
  const value = (written: string | undefined, prefix: string) => (written === undefined ? undefined : `${prefix}${written}`);
  switch (filter.mode) {
    case "is-null":
      return flags.supportNullTesting ? "NULL" : undefined;
    case "is-not-null":
      return flags.supportNullTesting ? "NOT NULL" : undefined;
    case "is-empty":
      return flags.supportEmpty ? "EMPTY" : undefined;
    case "is-not-empty":
      return flags.supportEmpty ? "NOT EMPTY" : undefined;
    case "is-blank":
      return flags.supportEmpty ? "NULL, EMPTY" : undefined;
    case "is-not-blank":
      return flags.supportEmpty ? "NOT NULL NOT EMPTY" : undefined;
    case "equals":
      return dataGridFilterSyntaxValueExpression(single(), behaviour);
    case "not-equals":
      if (behaviour === "datetime") {
        const date = operand(single(), behaviour);
        return date === undefined ? undefined : `<${date}, >${date}`;
      }
      return flags.supportEquals ? value(operand(single(), behaviour), "<>") : undefined;
    case "like":
    case "not-like":
    case "begins-with":
    case "ends-with":
    case "not-begins-with":
    case "not-ends-with":
      if (!flags.supportStringInclusion) return undefined;
      return value(operand(single(), behaviour), { like: "+", "not-like": "~", "begins-with": "^", "ends-with": "$", "not-begins-with": "!^", "not-ends-with": "!$" }[filter.mode]);
    case "less-than":
    case "less-than-or-equal":
    case "greater-than":
    case "greater-than-or-equal":
      if (!flags.supportNumberLikeComparison && !flags.supportDatetimeComparison) return undefined;
      return value(operand(single(), behaviour), { "less-than": "<", "less-than-or-equal": "<=", "greater-than": ">", "greater-than-or-equal": ">=" }[filter.mode]);
    case "in":
    case "not-in": {
      const terms = parseFilterValues(filter.rawValue, columnInfo).map((item) => (filter.mode === "in" ? dataGridFilterSyntaxValueExpression(item, behaviour) : item === null ? (flags.supportNullTesting ? "NOT NULL" : undefined) : value(operand(item, behaviour), "<>")));
      if (!terms.length || terms.some((term) => term === undefined)) return undefined;
      return terms.join(filter.mode === "in" ? ", " : " ");
    }
    case "between":
    case "not-between": {
      const start = operand(parseFilterValue(filter.rawValue, columnInfo), behaviour);
      const end = operand(parseFilterValue(filter.rawEndValue, columnInfo), behaviour);
      if (start === undefined || end === undefined || (!flags.supportNumberLikeComparison && !flags.supportDatetimeComparison)) return undefined;
      return filter.mode === "between" ? `>=${start} <=${end}` : `<${start}, >${end}`;
    }
    default:
      return undefined;
  }
}
