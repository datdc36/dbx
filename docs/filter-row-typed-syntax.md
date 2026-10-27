# Filter row: typed filter syntax (DbGate compatible)

Status: **implemented**, opt-in. Settings → Data → *Filter row style* (`dataGridFilterRowStyle`):

| Value | Filter row cell | Box text |
|---|---|---|
| `operator` (default) | `DataGridFilterRowCell.vue` | a value; the operator comes from ⋮ (plus date presets / partial dates) |
| `expression` | `DataGridFilterRowExpressionCell.vue` | an expression: `>10 <20`, `^ab, $yz`, `NULL`, `TODAY`, `{$$ > 5}` … |

The setting applies to the data grid filter row (table data and query results) and to the query
designer's Filter / OR / group filter columns.

DbGate is GPL-3.0 and DBX is Apache-2.0. The parser is a clean-room reimplementation of DbGate's
*behaviour* (`dbgate-filterparser`, v5.5.2 checked); no DbGate code is copied.

## 1. Where things live

| Piece | File |
|---|---|
| Parser, behaviours, expression writers | `apps/desktop/src/lib/dataGrid/dataGridFilterSyntax.ts` |
| Filter model (`DataGridFilterRowFilter.expression`) | `apps/desktop/src/lib/dataGrid/dataGridFilterRow.ts` |
| Predicate rendering (per atom, per dialect) | `build_data_grid_context_filter_condition*` in `crates/dbx-sql-data/src/data_grid_sql.rs` |
| Designer OR / AND groups | `QueryDesignerFilter.{and, or}` in `crates/dbx-sql-data/src/query_designer_sql.rs` |
| Tests | `lib/__tests__/dataGrid/dataGridFilterSyntax.spec.ts`, `components/grid/__tests__/DataGridFilterRowExpressionCell.spec.ts`, Rust `builds_typed_filter_syntax_predicates`, `a_filter_with_or_alternatives_is_parenthesised` |

The parser runs in the frontend because relative dates (`TODAY` …) must use the viewer's local
time zone at the moment the filter is applied, and dbx-web may run in another zone. It turns the
text into an OR of AND-groups of `(mode, value)` atoms; each atom is rendered by the existing Rust
builder (same command as value + operator filters), then joined: atoms with `AND`, groups with
`OR`, everything parenthesised. A filter is stored as `{ mode, rawValue, rawEndValue, expression }`;
when `expression` is set it wins.

New backend modes added for the syntax: `not-begins-with`, `not-ends-with`, `is-empty`,
`is-not-empty` (`TRIM(col) = ''` / `<> ''`; SQL Server `LTRIM(RTRIM())`; Oracle, where `''` is
NULL, `col IS NOT NULL AND TRIM(col) IS NULL`), `sql-template`, and the `likeCaseInsensitive`
option (`ILIKE` / `NOT ILIKE` on Postgres-family dialects, as DbGate does; others keep `LIKE`).

## 2. Column type → behaviour

From `dataGridFilterRowColumnKind`: `number` → number, `boolean` → logical, `datetime` → datetime,
`text` / `other` → string. Query designer: `COUNT` / `COUNT DISTINCT` group filters are numbers,
custom expressions are string.

| Construct | string | number | logical | datetime |
|---|:-:|:-:|:-:|:-:|
| date literals, `TODAY` …, `<=`/`>=`/`<`/`>` with dates | | | | ✓ |
| `NULL`, `NOT NULL`, `{sql}` | ✓ | ✓ | ✓ | ✓ |
| `=` `!=` `<>` `<` `<=` `>` `>=` with a value | ✓ | ✓ | | |
| `EMPTY`, `NOT EMPTY`, `0x…` | ✓ | | | |
| `^` `$` `+` `!^` `!$` `~` | ✓ | | | |
| `TRUE` / `FALSE` (any case), `1` / `0` | | | ✓ | |
| bare value | contains | equals | | |

Values: string columns take `"…"`, `'…'` (backslash escapes `\" \' \\ \n \t \r \b \f \uXXXX`) or a
bare word (anything except whitespace, `,`, quotes and `^`). Number columns take
`-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`, optionally quoted (`"12"`); the spelling is sent as typed,
so precision is kept.

## 3. Grammar

```
list    := factor ( "," factor )*      -- OR
factor  := element ( \s* element )*    -- AND; the whitespace is optional
```

Elements are tried in this order; the first that matches wins (only those allowed for the
behaviour take part):

1. date literal: `YYYY-M-D H:M:S` (space or `T`), `YYYY-M-D H:M`, `YYYY-M-D`, `YYYY-M`, `YYYY`
   → that second / minute / day / month / year
2. `TODAY` `TOMORROW` `YESTERDAY`, `THIS|LAST|NEXT WEEK|MONTH|YEAR`
3. `<=` / `>=` / `<` / `>` + date literal (`<=` and `>` use the end of the period, `>=` and `<` its start)
4. `NULL`, `NOT NULL`
5. `=`, `!=`, `<>` + value
6. `{…}` raw SQL; every `$$` becomes the column (`{$$ > 5}`), without `$$` the text is used as is
7. `<=`, `>=`, `<`, `>` + value
8. `EMPTY`, `NOT EMPTY`
9. `0x` + pairs of hex digits → equals (binary literal for binary columns)
10. `^v` begins, `$v` ends, `+v` contains, `!^v`, `!$v`, `~v` (negated)
11. `TRUE` / `FALSE`, then `1` / `0` (logical only)
12. bare value: contains (string) / equals (number)

Date periods are half-open local ranges, `col >= start AND col < end` (`2024-05` →
`>= '2024-05-01' AND < '2024-06-01'`), recomputed each time the filter is applied. Weeks start on
Monday, like the DBX presets.

Errors: the box turns red, the tooltip shows `Expected … at position N, found "…"`, and Enter /
blur do not apply it. A stored expression that no longer parses (e.g. the column type changed)
filters nothing, as in DbGate.

### Behaviour that follows from DbGate's grammar (kept on purpose)

- Keywords are upper-case only (`NULL`, `NOT`, `EMPTY`, `TODAY`, `THIS WEEK` …); `TRUE`/`FALSE`
  are case-insensitive. In a text column `null` searches for the text "null"; in a date column
  `today` is an error.
- No word boundaries: `NULLABLE` = `NULL` AND contains `ABLE`; `NOTNULL` = `NOT NULL`;
  `THISWEEK` = `THIS WEEK`; `>5<10` = two comparisons; `007` in a number column = `=0 =0 =7`;
  `10` in a boolean column = `TRUE FALSE`; `'it''s'` = contains `it` AND contains `s`.
- An operator with no operand is a bare word: `$`, `+`, `=`, `>` alone search for that character;
  `^` cannot start a bare word, so `^` alone is an error. `{}` in a text column searches for `{}`.
- `0xABC` = equals `0xAB` AND contains `C`. `{a} b` = raw `a` AND contains `b` (`{…}` ends at the
  first `}`).
- Date columns have no `=` / `<>`: the bare literal already means "within that period"
  (`<2024-05-01, >2024-05-01` is "not on that day"). `2024-05-01T13:45` (minute with `T`) and
  fractional seconds are errors.
- `EMPTY` is `TRIM(col) = ''`: whitespace-only text matches, NULL does not (DBX's own *Is blank*
  is `col IS NULL OR col = ''`).
- Text matching is case-insensitive on Postgres-family databases (`ILIKE`). `%` and `_` typed in a
  value stay LIKE wildcards.

### Deliberate differences from DbGate

| DbGate | DBX |
|---|---|
| `YESTERDAY` is in the menu but the parser rejects it | accepted |
| only the first backslash escape in a quoted string is decoded | all are decoded |
| `"12.5"` in a number column becomes `12` (regex group bug) | `12.5` |
| `a,` / `,a` produce an empty `()` and broken SQL | parse error |
| `{}` produces empty SQL | not a SQL condition (error in number/date/bool columns) |
| impossible dates (`2024-13`, `2024-02-30`) roll over or match nothing | parse error |
| periods end at `…23:59:59.999` (`<=`) | half-open `< next period` |
| weeks start on Sunday (moment's `en` locale) | Monday |
| `1`/`0` in boolean columns compare with the strings `'1'`/`'0'` | real boolean literals per dialect |
| Mongo-only constructs (`EXISTS`, `EMPTY ARRAY`, `ObjectId(…)`) | not supported (SQL grids only) |

## 4. The cell (`expression` style)

- The box text is the filter. Green when it parses, red with the parser message when it does not.
- Enter or blur applies, Esc clears, ↓ moves focus into the grid, ✕ clears.
- ⋮ menu, per behaviour (as in DbGate): *Equals… / Does not equal…*, *Is NULL / Is not NULL*,
  comparisons, *Contains / Does not contain / Starts with / Does not start with / Ends with /
  Does not end with…*, *Is empty / Is not empty*, *Is true / Is false / … or NULL*, date presets,
  *On or before… / On or after… / Within range…*, *SQL condition… / SQL condition – right side…*.
  Items ending in "…" write the operator (`=`, `^`, `{$$ }` …) and put the caret where the value
  goes; the others replace the filter and apply it.
- Multi-line paste turns each non-empty line into "is any of": `="a", ="b"` (numbers `=1, =2`,
  dates `2024-05-01, 2024-06`). `dataGridFilterSyntaxMultipleValues` also writes *is none of*
  (`<>"a" <>"b"`), *contains / begins / ends any of*.
- A value + operator filter made in `operator` style is shown as its equivalent expression
  (`begins-with ab` → `^"ab"`, `between 1 5` → `>=1 <=5`, *This week* → `THIS WEEK`) and keeps
  applying unchanged until edited. In `operator` style, a typed filter is shown as its text, labelled
  *Filter expression*, and keeps applying until edited.

## 5. Examples (Postgres)

| Column | Input | Predicate |
|---|---|---|
| text | `abc` | `"c" ILIKE '%abc%'` (non-text columns are cast: `"c"::text`) |
| text | `^ab, $yz` | `("c" ILIKE 'ab%') OR ("c" ILIKE '%yz')` |
| text | `="a b"` | `"c" = 'a b'` |
| text | `NOT EMPTY` | `TRIM("c") <> ''` |
| int | `>10 <20` | `("c" > 10) AND ("c" < 20)` |
| int | `1,2,3` | `("c" = 1) OR ("c" = 2) OR ("c" = 3)` |
| int | `abc` | error |
| bool | `TRUE, NULL` | `("c" = TRUE) OR ("c" IS NULL)` |
| date | `2024-05` | `("c" >= '2024-05-01') AND ("c" < '2024-06-01')` |
| date | `<= 2024` | `"c" < '2025-01-01'` |
| any | `NULL` | `"c" IS NULL` |
| any | `{$$ % 2 = 0}` | `"c" % 2 = 0` |
