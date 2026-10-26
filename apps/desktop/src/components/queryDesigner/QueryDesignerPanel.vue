<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Pane, Splitpanes } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import ELK from "elkjs/lib/elk.bundled.js";
import { FileCode, LayoutGrid, Loader2, Play, Redo2, Square, Undo2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import DataGrid from "@/components/grid/DataGrid.vue";
import SqlPreviewPanel from "@/components/editor/SqlPreviewPanel.vue";
import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import { isSchemaAware } from "@/lib/database/databaseFeatureSupport";
import { effectiveQueryResultMaxRows } from "@/lib/dataGrid/queryResultRowLimit";
import { sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import type { QueryEditorTableReferenceEntry } from "@/lib/editor/queryEditorTableDrop";
import type { DataGridFilterRowFilters } from "@/lib/dataGrid/dataGridFilterRow";
import { addDesignerTable, addForeignKeyTable, buildQueryDesignerSqlOptions, createQueryDesignerState, designerTableLabel, setDesignerTableAlias, type QueryDesignerForeignKey, type QueryDesignerState, type QueryDesignerTableSource } from "@/lib/queryDesigner/queryDesignerModel";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { QueryDesignerTabState, QueryResult } from "@/types/database";
import QueryDesignerCanvas from "./QueryDesignerCanvas.vue";
import QueryDesignerColumnsGrid from "./QueryDesignerColumnsGrid.vue";
import { QUERY_DESIGNER_CARD_WIDTH } from "./queryDesignerCanvasContext";

const HISTORY_LIMIT = 100;
const MERGE_WINDOW_MS = 1500;

const props = defineProps<{
  tabId: string;
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  initialState?: QueryDesignerTabState;
}>();

const emit = defineEmits<{
  "update:state": [state: QueryDesignerTabState];
  openSql: [sql: string];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();

const connection = computed(() => connectionStore.getConfig(props.connectionId));
const databaseType = computed(() => connection.value?.db_type);
const schemaAware = computed(() => isSchemaAware(databaseType.value));
/** Metadata APIs take the database name as "schema" on engines without schemas. */
const metadataSchema = computed(() => (schemaAware.value ? props.schema || "" : props.database));

const state = shallowRef<QueryDesignerState>(props.initialState?.design ?? createQueryDesignerState());
const undoStack = shallowRef<QueryDesignerState[]>([]);
const redoStack = shallowRef<QueryDesignerState[]>([]);
let lastMerge: { key: string; at: number } | null = null;

function persist(pendingTables?: QueryDesignerTabState["pendingTables"]) {
  emit("update:state", { design: state.value, pendingTables });
}

function applyChange(next: QueryDesignerState, mergeKey?: string) {
  if (next === state.value) return;
  const now = Date.now();
  const merges = !!mergeKey && lastMerge?.key === mergeKey && now - lastMerge.at < MERGE_WINDOW_MS;
  if (!merges) undoStack.value = [...undoStack.value, state.value].slice(-HISTORY_LIMIT);
  lastMerge = mergeKey ? { key: mergeKey, at: now } : null;
  redoStack.value = [];
  state.value = next;
  persist();
}

function undo() {
  const previous = undoStack.value[undoStack.value.length - 1];
  if (!previous) return;
  undoStack.value = undoStack.value.slice(0, -1);
  redoStack.value = [...redoStack.value, state.value];
  lastMerge = null;
  state.value = previous;
  persist();
}

function redo() {
  const next = redoStack.value[redoStack.value.length - 1];
  if (!next) return;
  redoStack.value = redoStack.value.slice(0, -1);
  undoStack.value = [...undoStack.value, state.value];
  lastMerge = null;
  state.value = next;
  persist();
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const tableError = ref("");
const tableNames = ref<string[]>([]);
const tableNamesLoading = ref(false);

async function loadTableNames() {
  if (tableNamesLoading.value || tableNames.value.length) return;
  tableNamesLoading.value = true;
  try {
    const tables = await api.listTables(props.connectionId, props.database, metadataSchema.value, undefined, undefined, undefined, undefined, props.catalog);
    tableNames.value = tables.filter((table) => table.table_type !== "MATERIALIZED_VIEW").map((table) => table.name);
  } catch (error) {
    tableError.value = String(error);
  } finally {
    tableNamesLoading.value = false;
  }
}

async function loadTableSource(entry: QueryEditorTableReferenceEntry): Promise<QueryDesignerTableSource | undefined> {
  const schema = schemaAware.value ? entry.schema || props.schema || "" : props.database;
  try {
    const [columns, foreignKeys] = await Promise.all([api.getColumns(props.connectionId, props.database, schema, entry.tableName, props.catalog), api.listForeignKeys(props.connectionId, props.database, schema, entry.tableName, props.catalog).catch(() => [])]);
    return { catalog: props.catalog, schema: schemaAware.value ? schema || undefined : undefined, tableName: entry.tableName, columns, foreignKeys };
  } catch (error) {
    tableError.value = t("queryDesigner.loadTableFailed", { table: entry.tableName, error: String(error) });
    return undefined;
  }
}

async function addTables(entries: QueryEditorTableReferenceEntry[], position: { x: number; y: number }) {
  tableError.value = "";
  const sources = await Promise.all(entries.map(loadTableSource));
  let next = state.value;
  sources.forEach((source, index) => {
    if (source) next = addDesignerTable(next, source, { x: Math.round(position.x + index * (QUERY_DESIGNER_CARD_WIDTH + 60)), y: Math.round(position.y) }, uuid);
  });
  applyChange(next);
}

function nextFreePosition() {
  if (!state.value.tables.length) return { x: 40, y: 40 };
  return { x: Math.max(...state.value.tables.map((table) => table.x)) + QUERY_DESIGNER_CARD_WIDTH + 60, y: 40 };
}

function handlePickTable(name: string) {
  if (name) void addTables([{ tableName: name, schema: props.schema }], nextFreePosition());
}

async function handleAddForeignKeyTable(designerId: string, foreignKey: QueryDesignerForeignKey) {
  const from = state.value.tables.find((table) => table.designerId === designerId);
  const source = await loadTableSource({ tableName: foreignKey.refTable, schema: foreignKey.refSchema ?? from?.schema });
  if (source) applyChange(addForeignKeyTable(state.value, designerId, foreignKey, source, uuid));
}

onMounted(() => {
  const pending = props.initialState?.pendingTables;
  if (pending?.length) {
    persist(undefined);
    void addTables(pending, { x: 40, y: 40 });
  }
});

// ---------------------------------------------------------------------------
// Alias dialog
// ---------------------------------------------------------------------------

const aliasTableId = ref<string | null>(null);
const aliasDraft = ref("");
const aliasTable = computed(() => state.value.tables.find((table) => table.designerId === aliasTableId.value));

function editAlias(designerId: string) {
  aliasTableId.value = designerId;
  aliasDraft.value = state.value.tables.find((table) => table.designerId === designerId)?.alias ?? "";
}

function saveAlias() {
  if (aliasTableId.value) applyChange(setDesignerTableAlias(state.value, aliasTableId.value, aliasDraft.value));
  aliasTableId.value = null;
}

// ---------------------------------------------------------------------------
// Arrange
// ---------------------------------------------------------------------------

const canvasRef = ref<InstanceType<typeof QueryDesignerCanvas> | null>(null);
const elk = new ELK();

async function arrange() {
  const tables = state.value.tables;
  if (!tables.length) return;
  const layout = await elk.layout({
    id: "root",
    layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "40", "elk.layered.spacing.nodeNodeBetweenLayers": "80" },
    children: tables.map((table) => ({ id: table.designerId, width: QUERY_DESIGNER_CARD_WIDTH, height: 38 + table.columns.length * 24 })),
    edges: state.value.references.map((reference) => ({ id: reference.designerId, sources: [reference.sourceId], targets: [reference.targetId] })),
  });
  const positions = new Map((layout.children ?? []).map((node) => [node.id, { x: Math.round(node.x ?? 0), y: Math.round(node.y ?? 0) }]));
  applyChange({ ...state.value, tables: tables.map((table) => ({ ...table, ...positions.get(table.designerId) })) });
  setTimeout(() => canvasRef.value?.fitView(), 50);
}

// ---------------------------------------------------------------------------
// SQL + execution
// ---------------------------------------------------------------------------

const sql = ref("");
let sqlRequest = 0;

async function regenerateSql() {
  const request = ++sqlRequest;
  if (!state.value.tables.length) {
    sql.value = "";
    return;
  }
  const options = buildQueryDesignerSqlOptions(state.value, databaseType.value, connectionStore.connectionIdentifierQuote?.(props.connectionId), schemaAware.value);
  try {
    const generated = await api.buildQueryDesignerSql(options);
    if (request === sqlRequest) sql.value = generated;
  } catch (error) {
    if (request === sqlRequest) sql.value = `-- ${String(error)}`;
  }
}

watch([state, databaseType], () => void regenerateSql(), { immediate: true });

const bottomTab = ref<"columns" | "sql" | "results">("columns");
const executing = ref(false);
const executionId = ref<string | null>(null);
const executionError = ref("");
const result = ref<QueryResult | null>(null);
const executedSql = ref("");
/** Designer SQL the current result came from, before any filter row wrapping. */
const resultBaseSql = ref("");
const resultFilters = ref<DataGridFilterRowFilters>({});
const maxRows = computed(() => effectiveQueryResultMaxRows(settingsStore.editorSettings.queryResultMaxRowsEnabled, settingsStore.editorSettings.queryResultMaxRows));
const rowsLimited = computed(() => !!result.value && maxRows.value !== undefined && result.value.rows.length >= maxRows.value);

function execute() {
  if (!sql.value.trim()) return;
  resultFilters.value = {};
  resultBaseSql.value = sql.value;
  return runStatement(sql.value);
}

/** Filter row on the results: re-run the designer SQL wrapped in `SELECT * FROM (…) dbx_filter WHERE …`. */
async function filterResult(filters: DataGridFilterRowFilters, whereInput: string | undefined) {
  const base = resultBaseSql.value;
  if (!base.trim()) return;
  if (!whereInput) {
    resultFilters.value = {};
    return runStatement(base);
  }
  const built = await api.buildFilteredQuerySql({ originalSql: base, databaseType: databaseType.value, resultColumns: result.value?.columns ?? [], whereInput });
  if (!built.ok || !built.sql) {
    executionError.value = t("grid.filterRowUnsupported", { reason: built.reason ?? "unsupported" });
    return;
  }
  resultFilters.value = filters;
  return runStatement(built.sql);
}

async function runStatement(statement: string) {
  if (executing.value) return;
  const id = uuid();
  executionId.value = id;
  executing.value = true;
  executionError.value = "";
  bottomTab.value = "results";
  try {
    await connectionStore.ensureConnected?.(props.connectionId);
    const response = await api.executeQuery(props.connectionId, props.database, statement, schemaAware.value ? props.schema : undefined, id, { maxRows: maxRows.value, catalog: props.catalog });
    if (executionId.value !== id) return;
    result.value = response;
    executedSql.value = statement;
  } catch (error) {
    if (executionId.value === id) executionError.value = String(error);
  } finally {
    if (executionId.value === id) {
      executing.value = false;
      executionId.value = null;
    }
  }
}

async function stop() {
  const id = executionId.value;
  if (!id) return;
  executionId.value = null;
  executing.value = false;
  await api.cancelQuery(id).catch(() => undefined);
}

function toggleDistinct() {
  applyChange({ ...state.value, distinct: !state.value.distinct });
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-9 shrink-0 items-center gap-1 border-b px-2">
      <SearchableSelect
        model-value=""
        :options="tableNames"
        :loading="tableNamesLoading"
        :placeholder="t('queryDesigner.addTable')"
        :search-placeholder="t('queryDesigner.searchTables')"
        :empty-text="t('queryDesigner.noTables')"
        :loading-text="t('queryDesigner.loadingTables')"
        trigger-class="h-7 w-44 text-xs"
        @update:open="(open: boolean) => open && loadTableNames()"
        @update:model-value="handlePickTable"
      />
      <div class="mx-1 h-5 w-px bg-border" />
      <Button size="sm" class="h-7 px-2 text-xs" :disabled="executing || !sql.trim()" @click="execute"><Play class="mr-1 h-3.5 w-3.5" />{{ t("queryDesigner.execute") }}</Button>
      <Button v-if="executing" variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="stop"><Square class="mr-1 h-3.5 w-3.5" />{{ t("queryDesigner.stop") }}</Button>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="!sql.trim()" @click="emit('openSql', sql)"><FileCode class="mr-1 h-3.5 w-3.5" />{{ t("queryDesigner.openSql") }}</Button>
      <div class="mx-1 h-5 w-px bg-border" />
      <label class="flex cursor-pointer items-center gap-1.5 px-1 text-xs">
        <input type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="!!state.distinct" @change="toggleDistinct" />
        {{ t("queryDesigner.distinct") }}
      </label>
      <span class="flex-1" />
      <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('queryDesigner.arrange')" :disabled="!state.tables.length" @click="arrange"><LayoutGrid class="h-3.5 w-3.5" /></Button>
      <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('grid.undoChange')" :disabled="!undoStack.length" @click="undo"><Undo2 class="h-3.5 w-3.5" /></Button>
      <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('grid.redoChange')" :disabled="!redoStack.length" @click="redo"><Redo2 class="h-3.5 w-3.5" /></Button>
    </div>
    <ErrorBanner v-if="tableError" :message="tableError" copy-mode="label" dismissible @dismiss="tableError = ''" />
    <Splitpanes horizontal class="min-h-0 flex-1">
      <Pane :size="60" min-size="20">
        <QueryDesignerCanvas ref="canvasRef" :flow-id="`query-designer-${tabId}`" :state="state" :connection-id="connectionId" :database="database" @change="applyChange" @drop-tables="addTables" @add-foreign-key-table="handleAddForeignKeyTable" @edit-alias="editAlias" />
      </Pane>
      <Pane :size="40" min-size="15" class="flex min-h-0 flex-col">
        <div class="flex h-8 shrink-0 items-center gap-1 border-b bg-muted/30 px-2 text-xs">
          <button v-for="tab in ['columns', 'sql', 'results'] as const" :key="tab" type="button" class="h-6 rounded px-2" :class="bottomTab === tab ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="bottomTab = tab">
            {{ t(`queryDesigner.${tab}Tab`) }}
            <Loader2 v-if="tab === 'results' && executing" class="ml-1 inline h-3 w-3 animate-spin" />
          </button>
        </div>
        <div class="min-h-0 flex-1">
          <QueryDesignerColumnsGrid v-if="bottomTab === 'columns'" :state="state" @change="applyChange" />
          <SqlPreviewPanel v-else-if="bottomTab === 'sql'" :sql="sql" :sql-format-dialect="sqlFormatDialectForDbType(databaseType)" :empty-message="t('queryDesigner.noSql')" :can-undo="!!undoStack.length" :can-redo="!!redoStack.length" :closable="false" @undo="undo" @redo="redo" />
          <div v-else class="flex h-full min-h-0 flex-col">
            <ErrorBanner v-if="executionError" :message="executionError" copy-mode="label" dismissible @dismiss="executionError = ''" />
            <div v-if="rowsLimited" class="border-b px-3 py-1 text-xs text-muted-foreground">{{ t("queryDesigner.rowsLimited", { count: maxRows }) }}</div>
            <DataGrid
              v-if="result"
              class="min-h-0 flex-1"
              :result="result"
              context="results"
              :sql="executedSql"
              :connection-id="connectionId"
              :database="database"
              :database-type="databaseType"
              :loading="executing"
              :filter-row-filters="resultFilters"
              :on-filter-row-apply="filterResult"
              @reload="runStatement(executedSql)"
            />
            <div v-else-if="!executionError" class="flex flex-1 items-center justify-center text-xs text-muted-foreground">
              <Loader2 v-if="executing" class="mr-2 h-4 w-4 animate-spin" />
              {{ executing ? "" : t("queryDesigner.notExecuted") }}
            </div>
          </div>
        </div>
      </Pane>
    </Splitpanes>
    <Dialog :open="!!aliasTableId" @update:open="(open: boolean) => !open && (aliasTableId = null)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{{ t("queryDesigner.aliasPrompt", { table: aliasTable ? designerTableLabel(aliasTable) : "" }) }}</DialogTitle>
        </DialogHeader>
        <Input v-model="aliasDraft" class="h-8 text-sm" autofocus @keydown.enter.prevent="saveAlias" />
        <DialogFooter>
          <Button variant="ghost" size="sm" @click="aliasTableId = null">{{ t("common.cancel") }}</Button>
          <Button size="sm" @click="saveAlias">{{ t("common.confirm") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
