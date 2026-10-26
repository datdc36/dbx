<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, provide, ref } from "vue";
import { useI18n } from "vue-i18n";
import { VueFlow, useVueFlow, ConnectionMode, type Connection, type Edge, type Node, type NodeDragEvent, type NodeTypesObject, type EdgeTypesObject } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { MiniMap } from "@vue-flow/minimap";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import { ArrowDownAZ, ArrowUpAZ, Link2, Pencil, Trash2, X } from "@lucide/vue";
import type { ContextMenuItem } from "@/components/ui/customContextMenuRegistry";
import { DBX_TABLE_REFERENCE_DROP_EVENT, type QueryEditorTableReferenceDropDetail, type QueryEditorTableReferenceEntry } from "@/lib/editor/queryEditorTableDrop";
import {
  QUERY_DESIGNER_JOIN_TYPES,
  canChangeJoinType,
  connectDesignerColumns,
  findDesignerColumn,
  moveDesignerTable,
  removeDesignerTable,
  removeReference,
  setDesignerTableAlias,
  setReferenceJoinType,
  updateDesignerColumn,
  type QueryDesignerColumnRef,
  type QueryDesignerForeignKey,
  type QueryDesignerReference,
  type QueryDesignerState,
} from "@/lib/queryDesigner/queryDesignerModel";
import { uuid } from "@/lib/common/utils";
import QueryDesignerTableNode from "./QueryDesignerTableNode.vue";
import QueryDesignerJoinEdge from "./QueryDesignerJoinEdge.vue";
import { QUERY_DESIGNER_CANVAS_KEY, columnFromHandleId, columnHandleId } from "./queryDesignerCanvasContext";

const props = defineProps<{
  flowId: string;
  state: QueryDesignerState;
  connectionId: string;
  database: string;
}>();

const emit = defineEmits<{
  change: [state: QueryDesignerState];
  dropTables: [tables: QueryEditorTableReferenceEntry[], position: { x: number; y: number }];
  addForeignKeyTable: [designerId: string, foreignKey: QueryDesignerForeignKey];
  editAlias: [designerId: string];
}>();

const { t } = useI18n();
const rootRef = ref<HTMLElement | null>(null);
const { screenToFlowCoordinate, fitView } = useVueFlow(props.flowId);

const nodeTypes = { "designer-table": markRaw(QueryDesignerTableNode) } as NodeTypesObject;
const edgeTypes = { "designer-join": markRaw(QueryDesignerJoinEdge) } as EdgeTypesObject;

const nodes = computed<Node[]>(() => props.state.tables.map((table) => ({ id: table.designerId, type: "designer-table", position: { x: table.x, y: table.y }, data: { table }, dragHandle: ".cursor-grab" })));

const edges = computed<Edge[]>(() =>
  props.state.references.flatMap((reference) => {
    const source = props.state.tables.find((table) => table.designerId === reference.sourceId);
    const target = props.state.tables.find((table) => table.designerId === reference.targetId);
    if (!source || !target) return [];
    const sourceOnLeft = source.x <= target.x;
    return reference.columns.map((pair, index) => ({
      id: `${reference.designerId}:${index}`,
      type: "designer-join",
      source: source.designerId,
      target: target.designerId,
      sourceHandle: columnHandleId(sourceOnLeft ? "right" : "left", pair.source),
      targetHandle: columnHandleId(sourceOnLeft ? "left" : "right", pair.target),
      data: { reference, showLabel: index === 0 },
    }));
  }),
);

function change(next: QueryDesignerState) {
  if (next !== props.state) emit("change", next);
}

function handleNodeDragStop(event: NodeDragEvent) {
  let next = props.state;
  for (const node of event.nodes) next = moveDesignerTable(next, node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) });
  change(next);
}

function handleConnect(connection: Connection) {
  const sourceColumn = columnFromHandleId(connection.sourceHandle);
  const targetColumn = columnFromHandleId(connection.targetHandle);
  if (!sourceColumn || !targetColumn) return;
  change(connectDesignerColumns(props.state, { designerId: connection.source, columnName: sourceColumn }, { designerId: connection.target, columnName: targetColumn }, uuid));
}

function onTableReferenceDrop(event: Event) {
  const detail = (event as CustomEvent<QueryEditorTableReferenceDropDetail>).detail;
  const root = rootRef.value;
  if (!detail || !root) return;
  const target = document.elementFromPoint(detail.clientX, detail.clientY);
  if (!(target instanceof Element) || !root.contains(target)) return;
  const { payload } = detail;
  if (payload.connectionId !== props.connectionId || payload.database !== props.database || payload.referenceType === "database") return;
  const entries = payload.tableReferences?.length ? payload.tableReferences : payload.tableName ? [{ schema: payload.schema, tableName: payload.tableName }] : [];
  if (entries.length) emit("dropTables", entries, screenToFlowCoordinate({ x: detail.clientX, y: detail.clientY }));
}

onMounted(() => window.addEventListener(DBX_TABLE_REFERENCE_DROP_EVENT, onTableReferenceDrop));
onBeforeUnmount(() => window.removeEventListener(DBX_TABLE_REFERENCE_DROP_EVENT, onTableReferenceDrop));

function setSort(ref: QueryDesignerColumnRef, direction: 1 | -1 | 0) {
  if (direction === 0) return change(updateDesignerColumn(props.state, ref, { sortOrder: 0 }));
  const used = props.state.columns.filter((column) => column.sortOrder && !(column.designerId === ref.designerId && column.columnName === ref.columnName)).map((column) => Math.abs(column.sortOrder!));
  const rank = findDesignerColumn(props.state, ref)?.sortOrder ? Math.abs(findDesignerColumn(props.state, ref)!.sortOrder!) : Math.max(0, ...used) + 1;
  change(updateDesignerColumn(props.state, ref, { sortOrder: rank * direction }));
}

provide(QUERY_DESIGNER_CANVAS_KEY, {
  state: computed(() => props.state),
  toggleOutput(ref) {
    change(updateDesignerColumn(props.state, ref, { isOutput: !findDesignerColumn(props.state, ref)?.isOutput }));
  },
  removeTable(designerId) {
    change(removeDesignerTable(props.state, designerId));
  },
  tableMenuItems(designerId): ContextMenuItem[] {
    const table = props.state.tables.find((candidate) => candidate.designerId === designerId);
    if (!table) return [];
    return [
      { label: t("queryDesigner.setAlias"), icon: Pencil, action: () => emit("editAlias", designerId) },
      { label: t("queryDesigner.removeAlias"), visible: !!table.alias, action: () => change(setDesignerTableAlias(props.state, designerId, undefined)) },
      { label: "", separator: true },
      { label: t("queryDesigner.removeTable"), icon: Trash2, variant: "destructive", action: () => change(removeDesignerTable(props.state, designerId)) },
    ];
  },
  columnMenuItems(ref): ContextMenuItem[] {
    const table = props.state.tables.find((candidate) => candidate.designerId === ref.designerId);
    const foreignKeys = table?.foreignKeys.filter((foreignKey) => foreignKey.columns.some((pair) => pair.column === ref.columnName)) ?? [];
    return [
      { label: t("queryDesigner.sortAscendingMenu"), icon: ArrowUpAZ, action: () => setSort(ref, 1) },
      { label: t("queryDesigner.sortDescendingMenu"), icon: ArrowDownAZ, action: () => setSort(ref, -1) },
      { label: t("queryDesigner.clearSort"), visible: !!findDesignerColumn(props.state, ref)?.sortOrder, action: () => setSort(ref, 0) },
      ...(foreignKeys.length ? [{ label: "", separator: true } as ContextMenuItem] : []),
      ...foreignKeys.map((foreignKey) => ({ label: t("queryDesigner.addReferencedTable", { table: foreignKey.refTable, key: foreignKey.name }), icon: Link2, action: () => emit("addForeignKeyTable", ref.designerId, foreignKey) })),
    ];
  },
  referenceMenuItems(reference: QueryDesignerReference): ContextMenuItem[] {
    const editable = canChangeJoinType(props.state, reference);
    return [
      ...QUERY_DESIGNER_JOIN_TYPES.map((joinType) => ({
        label: joinType.toUpperCase().replaceAll("-", " "),
        checked: reference.joinType === joinType,
        disabled: !editable && joinType !== "cross-join",
        title: editable ? undefined : t("queryDesigner.joinTypeLocked"),
        action: () => change(setReferenceJoinType(props.state, reference.designerId, joinType)),
      })),
      { label: "", separator: true },
      { label: t("queryDesigner.removeJoin"), icon: X, variant: "destructive", action: () => change(removeReference(props.state, reference.designerId)) },
    ];
  },
});

defineExpose({ fitView: () => fitView({ padding: 0.2, maxZoom: 1 }) });
</script>

<template>
  <div ref="rootRef" class="relative h-full w-full" data-query-designer-root>
    <VueFlow
      :id="flowId"
      :nodes="nodes"
      :edges="edges"
      :node-types="nodeTypes"
      :edge-types="edgeTypes"
      :connection-mode="ConnectionMode.Loose"
      :min-zoom="0.1"
      :max-zoom="2"
      :delete-key-code="null"
      class="h-full w-full"
      @node-drag-stop="handleNodeDragStop"
      @connect="handleConnect"
      @pane-ready="fitView({ padding: 0.2, maxZoom: 1 })"
    >
      <Background />
      <MiniMap pannable zoomable class="!bg-background/95" />
    </VueFlow>
    <div v-if="!state.tables.length" class="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {{ t("queryDesigner.emptyCanvas") }}
    </div>
  </div>
</template>
