# Filter row: typed filter syntax (deferred design)

Status: **not implemented**. The data-grid filter row ships with the "value + operator" model
(type a value, pick the operator from the ⋮ menu). This document describes the alternative the
filter row was designed to accept later: a typed expression language in the Filter box, as found
in DbGate (`>10`, `^abc`, `NULL`, `a,b,c`, `TODAY`…).

DbGate is GPL-3.0 and DBX is Apache-2.0. This document describes **behaviour only**; implement it
from this spec, do not copy DbGate source.

## 1. Goal

One text box per column accepts a small expression language. The text is parsed against the
column's type, turned into a predicate, and applied exactly like a value + operator filter
(table data: `WHERE` on the table query; query results: wrapped `SELECT * FROM (…) WHERE …`).
The ⋮ menu keeps working: picking an operator writes the equivalent typed expression into the box.

## 2. Column type → behaviour

Each column gets a *behaviour* that decides which constructs are legal. Classify from the column's
data type (reuse DBX type helpers: `isNumericType`, `isBooleanType`, date/time detection in
`lib/dataGrid/dataGridColumnFilter.ts` / `dbx_types::types`):

| Behaviour | Types | Allowed constructs |
|---|---|---|
| number | int, decimal, float, money… | `=` `!=` `<>` `<` `<=` `>` `>=`, plain number, `NULL` / `NOT NULL`, `{sql}` |
| string | char, varchar, text, uuid, json, unknown | everything in *number* except bare-number rule, plus `^` `$` `+` `!^` `!$` `~`, `EMPTY` / `NOT EMPTY`, hex `0x…`, quoted strings, bare words (= contains) |
| logical | bool, bit | `TRUE` / `FALSE` (case-insensitive), `1` / `0` when no other token kind is allowed, `NULL` / `NOT NULL`, `{sql}` |
| datetime | date, time, timestamp(tz), datetime | date literals, relative date words, `<` `<=` `>` `>=` with dates, `NULL` / `NOT NULL`, `{sql}` |

Unknown types fall back to *string*.

## 3. Grammar

```
list    := factor ( "," factor )*          -- OR of factors
factor  := element ( whitespace element )* -- AND of elements
element := one of the constructs below (whitespace around it is ignored)
```

So `>10 <20` means `> 10 AND < 20`, and `a, b` means *a OR b*.

### Values
- Quoted: `"text"` or `'text'`, with backslash escapes (`\"`, `\'`, `\\`, `\n`, `\t`).
- Quoted numbers: `"12"` / `'12'` parse as numbers in number columns.
- Number: `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`
- Bare string: any run of characters except whitespace, `,`, `'`, `"`.
- Hex: `0x` followed by an even number of hex digits → binary value (string behaviour only).

### Elements (in matching priority order: earlier wins)

| Syntax | Meaning | DBX filter mode |
|---|---|---|
| `2024-05-01 13:45:10` / `…T13:45:10` | that second | between start/end of second |
| `2024-05-01 13:45` | that minute | between start/end of minute |
| `2024-05-01` | that day | YEAR/MONTH/DAY of column = … (or between day start/end) |
| `2024-05` | that month | between month start/end |
| `2024` | that year | between year start/end |
| `TODAY` `YESTERDAY` `TOMORROW` | relative day | between day start/end |
| `THIS WEEK` `LAST WEEK` `NEXT WEEK` | relative week | between week start/end |
| `THIS MONTH` `LAST MONTH` `NEXT MONTH` | relative month | between |
| `THIS YEAR` `LAST YEAR` `NEXT YEAR` | relative year | between |
| `<= date` / `>= date` / `< date` / `> date` | date compare; `<=`/`>` use the **end** of the given period, `>=`/`<` its **start** (so `<= 2024-05` includes all of May) | less/greater-than(-or-equal) |
| `NULL` / `NOT NULL` | null test | is-null / is-not-null |
| `= v` / `!= v` / `<> v` | equality | equals / not-equals |
| `{ raw sql }` | raw SQL template; the column is substituted as the left side | (new: raw condition) |
| `< v` `<= v` `> v` `>= v` | comparison | less-than… / greater-than… |
| `EMPTY` / `NOT EMPTY` | empty string test | is-blank / is-not-blank |
| `0xABCD` | binary equality | equals |
| `^v` / `$v` / `+v` | begins / ends / contains | begins-with / ends-with / like |
| `!^v` / `!$v` / `~v` | negated begins / ends / contains | (new negated modes) / not-like |
| `TRUE` / `FALSE` | boolean | equals true/false |
| bare value (string columns) | contains | like |
| bare value (other columns) | equality | equals |

Relative and literal date ranges are computed **in the client's local time zone** at the moment
the filter is applied (re-applying "TODAY" tomorrow gives a new range).

### Errors
A text that does not parse is an error: show the input in a red state with the parser message as
tooltip, and do **not** apply it. A valid, applied filter shows a green/accent state.

## 4. Mapping to DBX

DBX already renders predicates from `(mode, value, values, endValue)` in Rust
(`build_data_grid_context_filter_condition*` in `crates/dbx-sql-data/src/data_grid_sql.rs`), with
per-dialect literal formatting and NULL handling. Recommended shape:

1. **Parser in Rust** (`crates/dbx-sql-data/src/filter_syntax.rs`), returning an AST:
   `Or(Vec<And(Vec<Atom>)>)`, `Atom = { mode, value, values, end_value } | Raw(String)`.
   Doing it in Rust keeps one implementation for desktop and web, and lets `dbx-cli` / MCP reuse it.
2. **Renderer**: reuse `build_data_grid_context_filter_condition_for_expression` for each atom;
   join atoms with `AND`, factors with `OR`, parenthesise each factor.
3. **New modes needed**: `not-begins-with`, `not-ends-with`, and a raw-template mode for `{…}`
   (gate `{…}` behind a setting; it injects raw SQL by design).
4. **Command**: `build_data_grid_filter_syntax_condition({ databaseType, identifierQuote, columnName,
   columnInfo, expression, qualifier? }) -> Result<Option<String>, FilterSyntaxError { message,
   position }>` (Tauri command + `dbx-web` route + `tauri.ts` / `http.ts` / `api.ts`).
5. **Frontend**: the filter row cell gets a per-column "syntax" mode, or a global setting
   `dataGridFilterRowSyntax: "value" | "typed"`. In typed mode the box text *is* the expression and
   the ⋮ menu inserts snippets (`=`, `^`, `NULL`, `TODAY`…) instead of switching a mode.

## 5. Extras worth keeping

- **Multi-line paste**: pasting text with newlines turns each non-empty line into a value:
  *is any of* → `='a','b'` → equals OR equals; *is none of* → `<>'a' <>'b'` (AND); *contains /
  begins / ends any of* → `'a','b'` / `^'a',^'b'` / `$'a',$'b'`.
- **Value from picker**: inserting a picked value writes `="value"`, `NULL`, `TRUE`/`FALSE`,
  `YYYY-MM-DD HH:mm:ss` for dates, `0x…` for binary.
- **Keys**: Enter applies, Esc clears, ↓ moves focus into the grid.

## 6. Test cases (table-driven)

| Column type | Input | Expected predicate (Postgres) |
|---|---|---|
| text | `abc` | `col::text LIKE '%abc%'` |
| text | `^ab, $yz` | `(col LIKE 'ab%') OR (col LIKE '%yz')` |
| text | `="a b"` | `col = 'a b'` |
| text | `NOT EMPTY` | `(col IS NOT NULL AND col <> '')` |
| int | `>10 <20` | `(col > 10 AND col < 20)` |
| int | `1,2,3` | `col = 1 OR col = 2 OR col = 3` |
| int | `abc` | parse error |
| bool | `true, null` | `col = TRUE OR col IS NULL` |
| date | `2024-05` | `col >= '2024-05-01 00:00:00' AND col <= '2024-05-31 23:59:59.999'` |
| date | `<= 2024` | `col <= '2024-12-31 23:59:59.999'` |
| any | `NULL` | `col IS NULL` |
| any | `{ {} > 5 }` | raw template (only when allowed) |
