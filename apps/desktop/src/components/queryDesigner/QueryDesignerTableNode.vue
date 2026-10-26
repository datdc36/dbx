<script setup lang="ts">
import { computed, inject } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { ArrowDown, ArrowUp, Filter, KeyRound, Link2, Table2, X } from "@lucide/vue";
import CustomContextMenu from "@/components/ui/CustomContextMenu.vue";
import { designerTableLabel, findDesignerColumn, type QueryDesignerTable } from "@/lib/queryDesigner/queryDesignerModel";
import { QUERY_DESIGNER_CANVAS_KEY, QUERY_DESIGNER_CARD_WIDTH, columnHandleId } from "./queryDesignerCanvasContext";

const props = defineProps<{
  data: { table: QueryDesignerTable };
  selected?: boolean;
}>();

const designer = inject(QUERY_DESIGNER_CANVAS_KEY)!;

const table = computed(() => props.data.table);
const title = computed(() => designerTableLabel(table.value));
const subtitle = computed(() => {
  const name = table.value.schema ? `${table.value.schema}.${table.value.tableName}` : table.value.tableName;
  return table.value.alias ? name : table.value.schema;
});
const foreignKeyColumns = computed(() => new Set(table.value.foreignKeys.flatMap((foreignKey) => foreignKey.columns.map((pair) => pair.column))));

function designerColumn(columnName: string) {
  return findDesignerColumn(designer.state.value, { designerId: table.value.designerId, columnName });
}

const handleClass = "!h-2 !w-2 !min-h-0 !min-w-0 !border-0 !bg-primary/60 opacity-0 group-hover:opacity-100";
</script>

<template>
  <div class="rounded-md border bg-background shadow-sm" :class="selected ? 'border-primary ring-1 ring-primary/30' : 'border-border'" :style="{ width: `${QUERY_DESIGNER_CARD_WIDTH}px` }">
    <CustomContextMenu :items="() => designer.tableMenuItems(table.designerId)" v-slot="{ onContextMenu }">
      <div class="flex h-9 cursor-grab items-center gap-2 border-b bg-muted/40 px-2 active:cursor-grabbing" @contextmenu="onContextMenu">
        <Table2 class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div class="flex min-w-0 flex-1 flex-col justify-center">
          <span class="truncate text-xs font-medium leading-tight" :title="title">{{ title }}</span>
          <span v-if="subtitle" class="truncate font-mono text-[10px] leading-none text-muted-foreground" :title="subtitle">{{ subtitle }}</span>
        </div>
        <button type="button" class="nodrag flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" @click.stop="designer.removeTable(table.designerId)">
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
    </CustomContextMenu>
    <div>
      <CustomContextMenu v-for="column in table.columns" :key="column.name" :items="() => designer.columnMenuItems({ designerId: table.designerId, columnName: column.name })" v-slot="{ onContextMenu }">
        <div class="group relative flex h-6 items-center gap-1.5 border-b border-border/40 px-2 text-xs last:border-b-0 hover:bg-accent/50" @contextmenu="onContextMenu">
          <Handle :id="columnHandleId('left', column.name)" type="source" :position="Position.Left" :class="handleClass" />
          <input type="checkbox" class="nodrag h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary" :checked="!!designerColumn(column.name)?.isOutput" @click.stop @change="designer.toggleOutput({ designerId: table.designerId, columnName: column.name })" />
          <KeyRound v-if="column.isPrimaryKey" class="h-3 w-3 shrink-0 text-amber-500" />
          <Link2 v-else-if="foreignKeyColumns.has(column.name)" class="h-3 w-3 shrink-0 text-primary" />
          <span v-else class="h-3 w-3 shrink-0" />
          <span class="min-w-0 flex-1 truncate font-mono" :title="`${column.name}: ${column.dataType}`">{{ column.name }}</span>
          <Filter v-if="designerColumn(column.name)?.filters?.some(Boolean)" class="h-3 w-3 shrink-0 text-primary" />
          <ArrowUp v-if="(designerColumn(column.name)?.sortOrder ?? 0) > 0" class="h-3 w-3 shrink-0 text-primary" />
          <ArrowDown v-if="(designerColumn(column.name)?.sortOrder ?? 0) < 0" class="h-3 w-3 shrink-0 text-primary" />
          <span class="max-w-20 shrink-0 truncate text-right text-[10px] text-muted-foreground" :title="column.dataType">{{ column.dataType }}</span>
          <Handle :id="columnHandleId('right', column.name)" type="source" :position="Position.Right" :class="handleClass" />
        </div>
      </CustomContextMenu>
    </div>
  </div>
</template>
