//! SQL generation for the visual query designer.
//!
//! The designer document is a set of canvas tables, references (joins) between their columns and
//! per-column settings (output, alias, grouping, aggregate, sort, filters). Tables connected by
//! join references form one `FROM ... JOIN` component; tables attached through `WHERE [NOT] EXISTS`
//! references become correlated sub-queries of the component they hang off; components that are
//! not connected at all are combined with `CROSS JOIN`. Cross-join references become plain
//! `WHERE` equality conditions.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

use crate::data_grid_sql::{
    build_data_grid_context_filter_condition_for_expression, data_grid_identifier, data_grid_qualified_table_name,
    DataGridColumnInfo, DataGridContextFilterConditionOptions, DataGridContextFilterMode,
};
use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDesignerSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
    #[serde(default)]
    pub tables: Vec<QueryDesignerTable>,
    #[serde(default)]
    pub references: Vec<QueryDesignerReference>,
    #[serde(default)]
    pub columns: Vec<QueryDesignerColumn>,
    #[serde(default)]
    pub distinct: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDesignerTable {
    pub designer_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// Vertical canvas position; the top-most table of a component becomes its `FROM` table.
    #[serde(default)]
    pub top: f64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueryDesignerJoinType {
    #[default]
    InnerJoin,
    LeftJoin,
    RightJoin,
    FullOuterJoin,
    CrossJoin,
    WhereExists,
    WhereNotExists,
}

impl QueryDesignerJoinType {
    fn is_join(self) -> bool {
        matches!(self, Self::InnerJoin | Self::LeftJoin | Self::RightJoin | Self::FullOuterJoin)
    }

    fn is_exists(self) -> bool {
        matches!(self, Self::WhereExists | Self::WhereNotExists)
    }

    fn join_keyword(self) -> &'static str {
        match self {
            Self::LeftJoin => "LEFT JOIN",
            Self::RightJoin => "RIGHT JOIN",
            Self::FullOuterJoin => "FULL OUTER JOIN",
            _ => "INNER JOIN",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDesignerReference {
    pub designer_id: String,
    pub source_id: String,
    pub target_id: String,
    #[serde(default)]
    pub join_type: QueryDesignerJoinType,
    #[serde(default)]
    pub columns: Vec<QueryDesignerReferenceColumn>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDesignerReferenceColumn {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueryDesignerAggregate {
    Min,
    Max,
    Count,
    CountDistinct,
    Sum,
    Avg,
}

impl QueryDesignerAggregate {
    fn label(self) -> &'static str {
        match self {
            Self::Min => "MIN",
            Self::Max => "MAX",
            Self::Count => "COUNT",
            Self::CountDistinct => "COUNT DISTINCT",
            Self::Sum => "SUM",
            Self::Avg => "AVG",
        }
    }

    fn apply(self, expression: &str) -> String {
        match self {
            Self::CountDistinct => format!("COUNT(DISTINCT {expression})"),
            _ => format!("{}({expression})", self.label()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDesignerFilter {
    pub mode: DataGridContextFilterMode,
    #[serde(default)]
    pub value: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_value: Option<Value>,
    /// Further predicates on the same column, AND-ed with this one (a date range is
    /// `>= start` plus `< end`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub and: Vec<QueryDesignerFilter>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDesignerColumn {
    /// Owning canvas table; custom expressions carry their own id that matches no table.
    pub designer_id: String,
    #[serde(default)]
    pub column_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_expression: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(default)]
    pub is_output: bool,
    #[serde(default)]
    pub is_grouped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregate: Option<QueryDesignerAggregate>,
    /// `0` = unsorted; `n` / `-n` = n-th sort key, ascending / descending.
    #[serde(default)]
    pub sort_order: i32,
    /// Slot `0` is the main filter, slot `n` the n-th OR filter. Filters within one slot are AND-ed,
    /// slots are OR-ed.
    #[serde(default)]
    pub filters: Vec<Option<QueryDesignerFilter>>,
    /// Same slot layout as `filters`, applied as `HAVING` on the output expression.
    #[serde(default)]
    pub group_filters: Vec<Option<QueryDesignerFilter>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_info: Option<DataGridColumnInfo>,
}

impl QueryDesignerColumn {
    fn custom_expression(&self) -> Option<&str> {
        self.custom_expression.as_deref().map(str::trim).filter(|expression| !expression.is_empty())
    }

    fn alias(&self) -> Option<&str> {
        self.alias.as_deref().map(str::trim).filter(|alias| !alias.is_empty())
    }
}

/// Builds the `SELECT` statement described by a query designer document. Returns an empty string
/// when the document has no tables.
pub fn build_query_designer_sql(options: &QueryDesignerSqlOptions) -> String {
    if options.tables.is_empty() {
        return String::new();
    }
    let builder = DesignerSqlBuilder::new(options);
    builder.build()
}

struct Component<'a> {
    /// `tables[0]` is the `FROM` table; `tables[i]` (i > 0) is attached by `join_references[i - 1]`.
    tables: Vec<&'a QueryDesignerTable>,
    join_references: Vec<&'a QueryDesignerReference>,
    sub_components: Vec<Component<'a>>,
    parent_reference: Option<&'a QueryDesignerReference>,
}

impl<'a> Component<'a> {
    fn new(root: &'a QueryDesignerTable) -> Self {
        Self { tables: vec![root], join_references: Vec::new(), sub_components: Vec::new(), parent_reference: None }
    }
}

struct DesignerSqlBuilder<'a> {
    options: &'a QueryDesignerSqlOptions,
    components: Vec<Component<'a>>,
}

impl<'a> DesignerSqlBuilder<'a> {
    fn new(options: &'a QueryDesignerSqlOptions) -> Self {
        let mut pending: Vec<&'a QueryDesignerTable> = options.tables.iter().collect();
        let mut components = Vec::new();
        while let Some(root) = top_most_table(&pending) {
            components.push(parse_component(options, root, &mut pending));
        }
        Self { options, components }
    }

    fn build(&self) -> String {
        let top_tables: Vec<&QueryDesignerTable> =
            self.components.iter().flat_map(|component| component.tables.iter().copied()).collect();
        let top_ids: HashSet<&str> = top_tables.iter().map(|table| table.designer_id.as_str()).collect();

        let mut from_lines = Vec::new();
        let mut where_conditions = Vec::new();
        for (index, component) in self.components.iter().enumerate() {
            let (lines, conditions) = self.render_component(component, &[]);
            for (line_index, line) in lines.into_iter().enumerate() {
                if index > 0 && line_index == 0 {
                    from_lines.push(format!("CROSS JOIN {line}"));
                } else {
                    from_lines.push(line);
                }
            }
            where_conditions.extend(conditions);
        }
        where_conditions.extend(self.loose_reference_conditions(&top_tables, &top_tables));

        let columns: Vec<&QueryDesignerColumn> = self
            .options
            .columns
            .iter()
            .filter(|column| top_ids.contains(column.designer_id.as_str()) || column.custom_expression().is_some())
            .collect();
        let is_grouped = columns.iter().any(|column| column.is_grouped || column.aggregate.is_some());

        let output: Vec<String> = columns
            .iter()
            .filter(|column| column.is_output)
            .filter_map(|column| self.output_field(column, is_grouped))
            .collect();

        if let Some(condition) =
            self.filter_condition(&columns, |column| &column.filters, |column| self.column_expression(column))
        {
            where_conditions.push(condition);
        }

        let group_by: Vec<String> = columns
            .iter()
            .filter(|column| column.is_grouped)
            .filter_map(|column| self.column_expression(column))
            .collect();

        let having = if is_grouped {
            self.filter_condition(
                &columns,
                |column| &column.group_filters,
                |column| self.result_expression(column, is_grouped),
            )
        } else {
            None
        };

        let mut sorted: Vec<&&QueryDesignerColumn> = columns.iter().filter(|column| column.sort_order != 0).collect();
        sorted.sort_by_key(|column| column.sort_order.unsigned_abs());
        let order_by: Vec<String> = sorted
            .into_iter()
            .filter_map(|column| {
                let expression = self.result_expression(column, is_grouped)?;
                Some(format!("{expression} {}", if column.sort_order < 0 { "DESC" } else { "ASC" }))
            })
            .collect();

        let mut lines = Vec::new();
        let select = if self.options.distinct { "SELECT DISTINCT" } else { "SELECT" };
        if output.is_empty() {
            lines.push(format!("{select} *"));
        } else {
            lines.push(select.to_string());
            push_list(&mut lines, &output);
        }
        push_from(&mut lines, from_lines);
        push_where(&mut lines, "WHERE", &where_conditions);
        if !group_by.is_empty() {
            lines.push("GROUP BY".to_string());
            push_list(&mut lines, &group_by);
        }
        if let Some(having) = having {
            push_where(&mut lines, "HAVING", &[having]);
        }
        if !order_by.is_empty() {
            lines.push("ORDER BY".to_string());
            push_list(&mut lines, &order_by);
        }
        lines.join("\n")
    }

    /// Renders a component's `FROM` lines and the `WHERE` conditions it contributes.
    /// `outer_tables` are the tables of enclosing components (empty for top-level components).
    fn render_component(
        &self,
        component: &Component<'a>,
        outer_tables: &[&'a QueryDesignerTable],
    ) -> (Vec<String>, Vec<String>) {
        let mut lines = vec![self.table_source(component.tables[0])];
        for (table, reference) in component.tables.iter().skip(1).zip(&component.join_references) {
            let conditions = self.reference_conditions(reference);
            let on = if conditions.is_empty() { "1 = 1".to_string() } else { conditions.join(" AND ") };
            lines.push(format!("{} {} ON {on}", reference.join_type.join_keyword(), self.table_source(table)));
        }

        let visible_tables: Vec<&'a QueryDesignerTable> =
            outer_tables.iter().copied().chain(component.tables.iter().copied()).collect();

        let mut conditions = Vec::new();
        for sub_component in &component.sub_components {
            let (sub_lines, sub_conditions) = self.render_component(sub_component, &visible_tables);
            let mut sub_query = vec!["SELECT *".to_string()];
            push_from(&mut sub_query, sub_lines);
            push_where(&mut sub_query, "WHERE", &sub_conditions);
            let keyword = match sub_component.parent_reference.map(|reference| reference.join_type) {
                Some(QueryDesignerJoinType::WhereNotExists) => "NOT EXISTS",
                _ => "EXISTS",
            };
            let body = sub_query.iter().map(|line| format!("  {line}")).collect::<Vec<_>>().join("\n");
            conditions.push(format!("{keyword} (\n{body}\n)"));
        }

        if let Some(parent_reference) = component.parent_reference {
            conditions.extend(self.reference_conditions(parent_reference));
            conditions.extend(self.loose_reference_conditions(&component.tables, &visible_tables));
            let ids: HashSet<&str> = component.tables.iter().map(|table| table.designer_id.as_str()).collect();
            let columns: Vec<&QueryDesignerColumn> =
                self.options.columns.iter().filter(|column| ids.contains(column.designer_id.as_str())).collect();
            if let Some(condition) =
                self.filter_condition(&columns, |column| &column.filters, |column| self.column_expression(column))
            {
                conditions.push(condition);
            }
        }
        (lines, conditions)
    }

    /// Equality conditions of cross-join references (and join references left unused because their
    /// tables were already connected) that link `tables` with `other_tables`.
    fn loose_reference_conditions(
        &self,
        tables: &[&QueryDesignerTable],
        other_tables: &[&QueryDesignerTable],
    ) -> Vec<String> {
        let used = self.used_reference_ids();
        self.options
            .references
            .iter()
            .filter(|reference| {
                reference.join_type == QueryDesignerJoinType::CrossJoin
                    || (reference.join_type.is_join() && !used.contains(reference.designer_id.as_str()))
            })
            .filter(|reference| reference_connects(reference, tables, other_tables))
            .flat_map(|reference| self.reference_conditions(reference))
            .collect()
    }

    fn used_reference_ids(&self) -> HashSet<&str> {
        fn collect<'r>(component: &Component<'r>, ids: &mut HashSet<&'r str>) {
            ids.extend(component.join_references.iter().map(|reference| reference.designer_id.as_str()));
            if let Some(reference) = component.parent_reference {
                ids.insert(reference.designer_id.as_str());
            }
            for sub_component in &component.sub_components {
                collect(sub_component, ids);
            }
        }
        let mut ids = HashSet::new();
        for component in &self.components {
            collect(component, &mut ids);
        }
        ids
    }

    fn reference_conditions(&self, reference: &QueryDesignerReference) -> Vec<String> {
        let (Some(source), Some(target)) = (self.table(&reference.source_id), self.table(&reference.target_id)) else {
            return Vec::new();
        };
        reference
            .columns
            .iter()
            .map(|column| {
                format!(
                    "{} = {}",
                    self.qualified_column(source, &column.source),
                    self.qualified_column(target, &column.target)
                )
            })
            .collect()
    }

    /// OR of the filter slots; each slot is the AND of that slot's column filters.
    fn filter_condition(
        &self,
        columns: &[&QueryDesignerColumn],
        filters: impl Fn(&QueryDesignerColumn) -> &Vec<Option<QueryDesignerFilter>>,
        expression: impl Fn(&QueryDesignerColumn) -> Option<String>,
    ) -> Option<String> {
        let slot_count = columns.iter().map(|column| filters(column).len()).max().unwrap_or(0);
        let mut slots = Vec::new();
        for slot in 0..slot_count {
            let conditions: Vec<String> = columns
                .iter()
                .filter_map(|column| {
                    let filter = filters(column).get(slot)?.as_ref()?;
                    let expression = expression(column)?;
                    self.filter_predicate(column, filter, &expression)
                })
                .collect();
            if !conditions.is_empty() {
                slots.push(conditions);
            }
        }
        match slots.len() {
            0 => None,
            1 => Some(slots.remove(0).join(" AND ")),
            _ => Some(format!(
                "({})",
                slots
                    .into_iter()
                    .map(|conditions| if conditions.len() == 1 {
                        conditions.into_iter().next().unwrap_or_default()
                    } else {
                        format!("({})", conditions.join(" AND "))
                    })
                    .collect::<Vec<_>>()
                    .join(" OR ")
            )),
        }
    }

    fn filter_predicate(
        &self,
        column: &QueryDesignerColumn,
        filter: &QueryDesignerFilter,
        expression: &str,
    ) -> Option<String> {
        if filter.and.is_empty() {
            return self.single_filter_predicate(column, filter, expression);
        }
        let predicates: Vec<String> = std::iter::once(filter)
            .chain(&filter.and)
            .filter_map(|part| self.single_filter_predicate(column, part, expression))
            .collect();
        match predicates.len() {
            0 => None,
            1 => predicates.into_iter().next(),
            _ => Some(predicates.join(" AND ")),
        }
    }

    fn single_filter_predicate(
        &self,
        column: &QueryDesignerColumn,
        filter: &QueryDesignerFilter,
        expression: &str,
    ) -> Option<String> {
        build_data_grid_context_filter_condition_for_expression(
            &DataGridContextFilterConditionOptions {
                database_type: self.options.database_type,
                identifier_quote: self.options.identifier_quote.clone(),
                column_name: column.column_name.clone(),
                mode: filter.mode,
                value: filter.value.clone(),
                values: filter.values.clone(),
                end_value: filter.end_value.clone(),
                column_info: column.column_info.clone(),
            },
            expression,
        )
    }

    fn output_field(&self, column: &QueryDesignerColumn, is_grouped: bool) -> Option<String> {
        let expression = self.result_expression(column, is_grouped)?;
        let alias = column.alias().map(str::to_string).or_else(|| {
            let aggregate = self.effective_aggregate(column, is_grouped)?;
            let name = if column.custom_expression().is_some() { None } else { Some(column.column_name.as_str()) };
            name.filter(|name| !name.is_empty()).map(|name| format!("{}({name})", aggregate.label()))
        });
        Some(match alias {
            Some(alias) => format!("{expression} AS {}", self.identifier(&alias)),
            None => expression,
        })
    }

    /// The column as it appears in the result: aggregated when the query is grouped and the column
    /// itself is not a grouping key.
    fn result_expression(&self, column: &QueryDesignerColumn, is_grouped: bool) -> Option<String> {
        let expression = self.column_expression(column)?;
        Some(match self.effective_aggregate(column, is_grouped) {
            Some(aggregate) => aggregate.apply(&expression),
            None => expression,
        })
    }

    fn effective_aggregate(&self, column: &QueryDesignerColumn, is_grouped: bool) -> Option<QueryDesignerAggregate> {
        if !is_grouped || column.is_grouped {
            return None;
        }
        Some(column.aggregate.unwrap_or(QueryDesignerAggregate::Max))
    }

    fn column_expression(&self, column: &QueryDesignerColumn) -> Option<String> {
        if let Some(expression) = column.custom_expression() {
            return Some(expression.to_string());
        }
        let table = self.table(&column.designer_id)?;
        if column.column_name.is_empty() {
            return None;
        }
        Some(self.qualified_column(table, &column.column_name))
    }

    fn qualified_column(&self, table: &QueryDesignerTable, column_name: &str) -> String {
        format!("{}.{}", self.table_qualifier(table), self.identifier(column_name))
    }

    fn table_qualifier(&self, table: &QueryDesignerTable) -> String {
        match table.alias.as_deref().map(str::trim).filter(|alias| !alias.is_empty()) {
            Some(alias) => self.identifier(alias),
            None => self.identifier(&table.table_name),
        }
    }

    fn table_source(&self, table: &QueryDesignerTable) -> String {
        let name = data_grid_qualified_table_name(
            self.options.database_type,
            table.catalog.as_deref(),
            table.schema.as_deref(),
            None,
            &table.table_name,
            self.options.identifier_quote.as_deref(),
        );
        match table.alias.as_deref().map(str::trim).filter(|alias| !alias.is_empty()) {
            Some(alias) => format!("{name} {}", self.identifier(alias)),
            None => name,
        }
    }

    fn identifier(&self, name: &str) -> String {
        data_grid_identifier(self.options.database_type, name, self.options.identifier_quote.as_deref())
    }

    fn table(&self, designer_id: &str) -> Option<&'a QueryDesignerTable> {
        self.options.tables.iter().find(|table| table.designer_id == designer_id)
    }
}

fn top_most_table<'a>(tables: &[&'a QueryDesignerTable]) -> Option<&'a QueryDesignerTable> {
    tables.iter().copied().reduce(|best, table| if table.top < best.top { table } else { best })
}

fn parse_component<'a>(
    options: &'a QueryDesignerSqlOptions,
    root: &'a QueryDesignerTable,
    pending: &mut Vec<&'a QueryDesignerTable>,
) -> Component<'a> {
    pending.retain(|table| !std::ptr::eq(*table, root));
    let mut component = Component::new(root);

    while let Some((index, reference)) =
        find_pending_connection(options, &component.tables, pending, |join_type| join_type.is_join())
    {
        component.tables.push(pending.remove(index));
        component.join_references.push(reference);
    }

    while let Some((index, reference)) =
        find_pending_connection(options, &component.tables, pending, |join_type| join_type.is_exists())
    {
        let mut sub_component = parse_component(options, pending[index], pending);
        sub_component.parent_reference = Some(reference);
        component.sub_components.push(sub_component);
    }

    component
}

/// First pending table (in document order) connected to `tables` by a reference of an accepted type.
fn find_pending_connection<'a>(
    options: &'a QueryDesignerSqlOptions,
    tables: &[&'a QueryDesignerTable],
    pending: &[&'a QueryDesignerTable],
    accepts: impl Fn(QueryDesignerJoinType) -> bool,
) -> Option<(usize, &'a QueryDesignerReference)> {
    pending.iter().enumerate().find_map(|(index, candidate)| {
        options
            .references
            .iter()
            .find(|reference| accepts(reference.join_type) && reference_connects(reference, tables, &[*candidate]))
            .map(|reference| (index, reference))
    })
}

fn reference_connects(
    reference: &QueryDesignerReference,
    tables: &[&QueryDesignerTable],
    other_tables: &[&QueryDesignerTable],
) -> bool {
    let contains = |list: &[&QueryDesignerTable], id: &str| list.iter().any(|table| table.designer_id == id);
    (contains(tables, &reference.source_id) && contains(other_tables, &reference.target_id))
        || (contains(tables, &reference.target_id) && contains(other_tables, &reference.source_id))
}

fn push_list(lines: &mut Vec<String>, items: &[String]) {
    let last = items.len().saturating_sub(1);
    for (index, item) in items.iter().enumerate() {
        let item = indent_continuation(item);
        lines.push(if index == last { format!("  {item}") } else { format!("  {item},") });
    }
}

fn push_from(lines: &mut Vec<String>, from_lines: Vec<String>) {
    for (index, line) in from_lines.into_iter().enumerate() {
        lines.push(if index == 0 { format!("FROM {line}") } else { format!("  {line}") });
    }
}

fn push_where(lines: &mut Vec<String>, keyword: &str, conditions: &[String]) {
    for (index, condition) in conditions.iter().enumerate() {
        let condition = indent_continuation(condition);
        lines.push(if index == 0 { format!("{keyword} {condition}") } else { format!("  AND {condition}") });
    }
}

/// Keeps multi-line fragments (EXISTS sub-queries) aligned under the clause they belong to.
fn indent_continuation(text: &str) -> String {
    text.replace('\n', "\n  ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn table(id: &str, name: &str, top: f64) -> QueryDesignerTable {
        QueryDesignerTable { designer_id: id.to_string(), table_name: name.to_string(), top, ..Default::default() }
    }

    fn reference(
        id: &str,
        source: &str,
        target: &str,
        join_type: QueryDesignerJoinType,
        cols: &[(&str, &str)],
    ) -> QueryDesignerReference {
        QueryDesignerReference {
            designer_id: id.to_string(),
            source_id: source.to_string(),
            target_id: target.to_string(),
            join_type,
            columns: cols
                .iter()
                .map(|(source, target)| QueryDesignerReferenceColumn {
                    source: source.to_string(),
                    target: target.to_string(),
                })
                .collect(),
        }
    }

    fn column(table: &str, name: &str) -> QueryDesignerColumn {
        QueryDesignerColumn { designer_id: table.to_string(), column_name: name.to_string(), ..Default::default() }
    }

    fn output(table: &str, name: &str) -> QueryDesignerColumn {
        QueryDesignerColumn { is_output: true, ..column(table, name) }
    }

    fn filter(mode: DataGridContextFilterMode, value: Value) -> Option<QueryDesignerFilter> {
        Some(QueryDesignerFilter { mode, value, values: Vec::new(), end_value: None, and: Vec::new() })
    }

    fn postgres(
        tables: Vec<QueryDesignerTable>,
        references: Vec<QueryDesignerReference>,
        columns: Vec<QueryDesignerColumn>,
    ) -> QueryDesignerSqlOptions {
        QueryDesignerSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            tables,
            references,
            columns,
            ..Default::default()
        }
    }

    #[test]
    fn empty_document_has_no_sql() {
        assert_eq!(build_query_designer_sql(&QueryDesignerSqlOptions::default()), "");
    }

    #[test]
    fn single_table_without_output_columns_selects_everything() {
        let sql = build_query_designer_sql(&postgres(vec![table("a", "users", 0.0)], vec![], vec![]));
        assert_eq!(sql, "SELECT *\nFROM \"users\"");
    }

    #[test]
    fn joins_follow_references_from_the_top_most_table() {
        let sql = build_query_designer_sql(&postgres(
            vec![table("o", "orders", 200.0), table("c", "customers", 10.0), table("i", "items", 400.0)],
            vec![
                reference("r1", "o", "c", QueryDesignerJoinType::InnerJoin, &[("customer_id", "id")]),
                reference("r2", "i", "o", QueryDesignerJoinType::LeftJoin, &[("order_id", "id")]),
            ],
            vec![output("c", "name"), output("o", "total")],
        ));
        assert_eq!(
            sql,
            "SELECT\n  \"customers\".\"name\",\n  \"orders\".\"total\"\nFROM \"customers\"\n  INNER JOIN \"orders\" ON \"orders\".\"customer_id\" = \"customers\".\"id\"\n  LEFT JOIN \"items\" ON \"items\".\"order_id\" = \"orders\".\"id\""
        );
    }

    #[test]
    fn schema_and_alias_are_used_for_sources_and_qualifiers() {
        let mut users = table("a", "users", 0.0);
        users.schema = Some("app".to_string());
        users.alias = Some("u".to_string());
        let sql = build_query_designer_sql(&postgres(vec![users], vec![], vec![output("a", "id")]));
        assert_eq!(sql, "SELECT\n  \"u\".\"id\"\nFROM \"app\".\"users\" \"u\"");
    }

    #[test]
    fn unconnected_tables_are_cross_joined_and_cross_references_become_conditions() {
        let sql = build_query_designer_sql(&postgres(
            vec![table("a", "a", 0.0), table("b", "b", 100.0)],
            vec![reference("r", "a", "b", QueryDesignerJoinType::CrossJoin, &[("x", "y")])],
            vec![],
        ));
        assert_eq!(sql, "SELECT *\nFROM \"a\"\n  CROSS JOIN \"b\"\nWHERE \"a\".\"x\" = \"b\".\"y\"");
    }

    #[test]
    fn exists_references_become_correlated_sub_queries_with_their_filters() {
        let mut item_filter = column("i", "qty");
        item_filter.filters = vec![filter(DataGridContextFilterMode::GreaterThan, json!(5))];
        let sql = build_query_designer_sql(&postgres(
            vec![table("o", "orders", 0.0), table("i", "items", 100.0)],
            vec![reference("r", "o", "i", QueryDesignerJoinType::WhereNotExists, &[("id", "order_id")])],
            vec![output("o", "id"), item_filter],
        ));
        assert_eq!(
            sql,
            "SELECT\n  \"orders\".\"id\"\nFROM \"orders\"\nWHERE NOT EXISTS (\n    SELECT *\n    FROM \"items\"\n    WHERE \"orders\".\"id\" = \"items\".\"order_id\"\n      AND \"items\".\"qty\" > 5\n  )"
        );
    }

    #[test]
    fn grouping_aggregates_other_output_columns() {
        let mut country = output("c", "country");
        country.is_grouped = true;
        let mut count = output("c", "id");
        count.aggregate = Some(QueryDesignerAggregate::CountDistinct);
        count.sort_order = -1;
        count.group_filters = vec![filter(DataGridContextFilterMode::GreaterThan, json!(10))];
        let name = output("c", "name");
        let sql =
            build_query_designer_sql(&postgres(vec![table("c", "customers", 0.0)], vec![], vec![country, count, name]));
        assert_eq!(
            sql,
            "SELECT\n  \"customers\".\"country\",\n  COUNT(DISTINCT \"customers\".\"id\") AS \"COUNT DISTINCT(id)\",\n  MAX(\"customers\".\"name\") AS \"MAX(name)\"\nFROM \"customers\"\nGROUP BY\n  \"customers\".\"country\"\nHAVING COUNT(DISTINCT \"customers\".\"id\") > 10\nORDER BY\n  COUNT(DISTINCT \"customers\".\"id\") DESC"
        );
    }

    #[test]
    fn filter_slots_are_and_within_and_or_between() {
        let mut name = column("c", "name");
        name.filters = vec![
            filter(DataGridContextFilterMode::Like, json!("an")),
            filter(DataGridContextFilterMode::IsNull, Value::Null),
        ];
        let mut age = column("c", "age");
        age.filters = vec![filter(DataGridContextFilterMode::GreaterThanOrEqual, json!(18))];
        let sql = build_query_designer_sql(&postgres(vec![table("c", "customers", 0.0)], vec![], vec![name, age]));
        assert_eq!(
            sql,
            "SELECT *\nFROM \"customers\"\nWHERE ((\"customers\".\"name\"::text LIKE '%an%' AND \"customers\".\"age\" >= 18) OR \"customers\".\"name\" IS NULL)"
        );
    }

    #[test]
    fn sort_keys_follow_their_rank_and_distinct_is_applied() {
        let mut first = output("c", "a");
        first.sort_order = 2;
        let mut second = output("c", "b");
        second.sort_order = -1;
        let mut options = postgres(vec![table("c", "t", 0.0)], vec![], vec![first, second]);
        options.distinct = true;
        let sql = build_query_designer_sql(&options);
        assert_eq!(sql, "SELECT DISTINCT\n  \"t\".\"a\",\n  \"t\".\"b\"\nFROM \"t\"\nORDER BY\n  \"t\".\"b\" DESC,\n  \"t\".\"a\" ASC");
    }

    #[test]
    fn custom_expressions_are_emitted_verbatim_with_alias() {
        let expression = QueryDesignerColumn {
            designer_id: "expr-1".to_string(),
            custom_expression: Some("1 + 1".to_string()),
            alias: Some("two".to_string()),
            is_output: true,
            ..Default::default()
        };
        let sql = build_query_designer_sql(&postgres(vec![table("t", "t", 0.0)], vec![], vec![expression]));
        assert_eq!(sql, "SELECT\n  1 + 1 AS \"two\"\nFROM \"t\"");
    }

    #[test]
    fn redundant_join_references_become_where_conditions() {
        let sql = build_query_designer_sql(&postgres(
            vec![table("a", "a", 0.0), table("b", "b", 100.0)],
            vec![
                reference("r1", "a", "b", QueryDesignerJoinType::InnerJoin, &[("id", "a_id")]),
                reference("r2", "a", "b", QueryDesignerJoinType::InnerJoin, &[("code", "a_code")]),
            ],
            vec![],
        ));
        assert_eq!(
            sql,
            "SELECT *\nFROM \"a\"\n  INNER JOIN \"b\" ON \"a\".\"id\" = \"b\".\"a_id\"\nWHERE \"a\".\"code\" = \"b\".\"a_code\""
        );
    }

    #[test]
    fn a_filter_with_and_parts_becomes_a_range() {
        let mut created = column("o", "created");
        created.filters = vec![Some(QueryDesignerFilter {
            mode: DataGridContextFilterMode::GreaterThanOrEqual,
            value: json!("2026-09-01"),
            values: Vec::new(),
            end_value: None,
            and: vec![QueryDesignerFilter {
                mode: DataGridContextFilterMode::LessThan,
                value: json!("2026-10-01"),
                values: Vec::new(),
                end_value: None,
                and: Vec::new(),
            }],
        })];
        let sql = build_query_designer_sql(&postgres(vec![table("o", "orders", 0.0)], vec![], vec![created]));
        assert_eq!(
            sql,
            "SELECT *\nFROM \"orders\"\nWHERE \"orders\".\"created\" >= '2026-09-01' AND \"orders\".\"created\" < '2026-10-01'"
        );
    }

    #[test]
    fn mysql_uses_backticks() {
        let options = QueryDesignerSqlOptions {
            database_type: Some(DatabaseType::Mysql),
            tables: vec![table("a", "users", 0.0)],
            columns: vec![output("a", "id")],
            ..Default::default()
        };
        assert_eq!(build_query_designer_sql(&options), "SELECT\n  `users`.`id`\nFROM `users`");
    }

    #[test]
    fn options_deserialize_from_frontend_json() {
        let options: QueryDesignerSqlOptions = serde_json::from_value(json!({
            "databaseType": "postgres",
            "tables": [{ "designerId": "a", "tableName": "users", "top": 0 }],
            "references": [],
            "columns": [{
                "designerId": "a",
                "columnName": "name",
                "isOutput": true,
                "aggregate": "count-distinct",
                "filters": [null, { "mode": "begins-with", "value": "J" }]
            }],
            "distinct": false
        }))
        .unwrap();
        assert_eq!(options.columns[0].aggregate, Some(QueryDesignerAggregate::CountDistinct));
        assert!(options.columns[0].filters[0].is_none());
        assert_eq!(
            build_query_designer_sql(&options),
            "SELECT\n  COUNT(DISTINCT \"users\".\"name\") AS \"COUNT DISTINCT(name)\"\nFROM \"users\"\nWHERE \"users\".\"name\"::text LIKE 'J%'"
        );
    }
}
