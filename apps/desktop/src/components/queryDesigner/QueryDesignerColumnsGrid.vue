<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowDown, ArrowUp, Minus, Plus, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { uuid } from "@/lib/common/utils";
import {
  QUERY_DESIGNER_AGGREGATES,
  QUERY_DESIGNER_MAX_SORT_RANK,
  addCustomExpressionColumn,
  designerTableLabel,
  isGroupedDesign,
  moveDesignerColumn,
  removeDesignerColumn,
  setOrFilterCount,
  updateDesignerColumn,
  type QueryDesignerAggregate,
  type QueryDesignerColumn,
  type QueryDesignerColumnFilter,
  type QueryDesignerState,
} from "@/lib/queryDesigner/queryDesignerModel";
import QueryDesignerFilterCell from "./QueryDesignerFilterCell.vue";

const NONE = "__none";

const props = defineProps<{
  state: QueryDesignerState;
}>();

const emit = defineEmits<{
  /** `mergeKey` lets consecutive keystrokes in one field collapse into a single undo step. */
  change: [state: QueryDesignerState, mergeKey?: string];
}>();

const { t } = useI18n();

const grouped = computed(() => isGroupedDesign(props.state));
const filterSlots = computed(() => Array.from({ length: 1 + (props.state.orFilterCount ?? 0) }, (_, slot) => slot));
const groupFilterSlots = computed(() => (grouped.value ? Array.from({ length: 1 + (props.state.groupOrFilterCount ?? 0) }, (_, slot) => slot) : []));
const sortOptions = computed(() =>
  Array.from({ length: QUERY_DESIGNER_MAX_SORT_RANK }, (_, index) => index + 1).flatMap((rank) => [
    { value: String(rank), label: t("queryDesigner.sortAscending", { rank }) },
    { value: String(-rank), label: t("queryDesigner.sortDescending", { rank }) },
  ]),
);

function tableLabel(column: QueryDesignerColumn): string {
  const table = props.state.tables.find((candidate) => candidate.designerId === column.designerId);
  return table ? designerTableLabel(table) : "";
}

function rowKey(column: QueryDesignerColumn): string {
  return `${column.designerId}\u0000${column.columnName}`;
}

function update(column: QueryDesignerColumn, patch: Partial<QueryDesignerColumn>, mergeKey?: string) {
  emit("change", updateDesignerColumn(props.state, column, patch), mergeKey ? `${rowKey(column)}:${mergeKey}` : undefined);
}

function setFilter(column: QueryDesignerColumn, key: "filters" | "groupFilters", slot: number, filter: QueryDesignerColumnFilter | null) {
  const filters = [...(column[key] ?? [])];
  while (filters.length <= slot) filters.push(null);
  filters[slot] = filter;
  while (filters.length && !filters[filters.length - 1]) filters.pop();
  update(column, { [key]: filters.length ? filters : undefined }, `${key}:${slot}`);
}

function setAggregate(column: QueryDesignerColumn, value: unknown) {
  update(column, { aggregate: value === NONE ? undefined : (String(value) as QueryDesignerAggregate) });
}

function setSortOrder(column: QueryDesignerColumn, value: unknown) {
  update(column, { sortOrder: value === NONE ? 0 : Number(value) });
}

function aggregateLabel(aggregate: QueryDesignerAggregate): string {
  return aggregate.toUpperCase().replace("-", " ");
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full border-collapse text-xs">
        <thead class="sticky top-0 z-10 bg-muted/60 backdrop-blur">
          <tr class="text-left text-muted-foreground">
            <th class="px-2 py-1.5 font-medium">{{ t("queryDesigner.column") }}</th>
            <th class="px-2 py-1.5 font-medium">{{ t("queryDesigner.table") }}</th>
            <th class="px-2 py-1.5 text-center font-medium">{{ t("queryDesigner.output") }}</th>
            <th class="px-2 py-1.5 font-medium">{{ t("queryDesigner.alias") }}</th>
            <th class="px-2 py-1.5 text-center font-medium">{{ t("queryDesigner.groupBy") }}</th>
            <th class="px-2 py-1.5 font-medium">{{ t("queryDesigner.aggregate") }}</th>
            <th class="px-2 py-1.5 font-medium">{{ t("queryDesigner.sortOrder") }}</th>
            <th v-for="slot in filterSlots" :key="`filter-${slot}`" class="px-2 py-1.5 font-medium">{{ slot === 0 ? t("queryDesigner.filter") : t("queryDesigner.orFilter", { n: slot + 1 }) }}</th>
            <th v-for="slot in groupFilterSlots" :key="`group-filter-${slot}`" class="px-2 py-1.5 font-medium">{{ slot === 0 ? t("queryDesigner.groupFilter") : t("queryDesigner.groupOrFilter", { n: slot + 1 }) }}</th>
            <th class="w-20 px-2 py-1.5" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="column in state.columns" :key="rowKey(column)" class="border-b border-border/50 hover:bg-accent/30">
            <td class="px-2 py-1">
              <Input
                v-if="column.customExpression !== undefined"
                class="h-7 min-w-40 px-2 font-mono text-xs"
                :model-value="column.customExpression"
                :placeholder="t('queryDesigner.expressionPlaceholder')"
                @update:model-value="(value) => update(column, { customExpression: String(value ?? '') }, 'expression')"
              />
              <span v-else class="font-mono">{{ column.columnName }}</span>
            </td>
            <td class="px-2 py-1 text-muted-foreground">{{ tableLabel(column) }}</td>
            <td class="px-2 py-1 text-center">
              <input type="checkbox" class="h-3.5 w-3.5 cursor-pointer accent-primary" :checked="!!column.isOutput" @change="update(column, { isOutput: !column.isOutput })" />
            </td>
            <td class="px-2 py-1">
              <Input class="h-7 min-w-24 px-2 text-xs" :model-value="column.alias ?? ''" @update:model-value="(value) => update(column, { alias: String(value ?? '') || undefined }, 'alias')" />
            </td>
            <td class="px-2 py-1 text-center">
              <input type="checkbox" class="h-3.5 w-3.5 cursor-pointer accent-primary" :checked="!!column.isGrouped" @change="update(column, { isGrouped: !column.isGrouped })" />
            </td>
            <td class="px-2 py-1">
              <Select v-if="!column.isGrouped" :model-value="column.aggregate ?? NONE" @update:model-value="(value) => setAggregate(column, value)">
                <SelectTrigger size="sm" class="h-7 w-32 px-2 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem :value="NONE" class="text-xs">{{ t("queryDesigner.none") }}</SelectItem>
                  <SelectItem v-for="aggregate in QUERY_DESIGNER_AGGREGATES" :key="aggregate" :value="aggregate" class="text-xs">{{ aggregateLabel(aggregate) }}</SelectItem>
                </SelectContent>
              </Select>
            </td>
            <td class="px-2 py-1">
              <Select :model-value="column.sortOrder ? String(column.sortOrder) : NONE" @update:model-value="(value) => setSortOrder(column, value)">
                <SelectTrigger size="sm" class="h-7 w-32 px-2 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem :value="NONE" class="text-xs">{{ t("queryDesigner.none") }}</SelectItem>
                  <SelectItem v-for="option in sortOptions" :key="option.value" :value="option.value" class="text-xs">{{ option.label }}</SelectItem>
                </SelectContent>
              </Select>
            </td>
            <td v-for="slot in filterSlots" :key="`filter-${slot}`" class="px-2 py-1">
              <QueryDesignerFilterCell :filter="column.filters?.[slot]" @change="(filter) => setFilter(column, 'filters', slot, filter)" />
            </td>
            <td v-for="slot in groupFilterSlots" :key="`group-filter-${slot}`" class="px-2 py-1">
              <QueryDesignerFilterCell :filter="column.groupFilters?.[slot]" @change="(filter) => setFilter(column, 'groupFilters', slot, filter)" />
            </td>
            <td class="px-2 py-1">
              <div class="flex items-center justify-end gap-0.5">
                <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('queryDesigner.moveUp')" @click="emit('change', moveDesignerColumn(state, column, -1))"><ArrowUp class="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('queryDesigner.moveDown')" @click="emit('change', moveDesignerColumn(state, column, 1))"><ArrowDown class="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" class="h-6 w-6 text-destructive" :title="t('queryDesigner.removeColumn')" @click="emit('change', removeDesignerColumn(state, column))"><Trash2 class="h-3.5 w-3.5" /></Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!state.columns.length" class="px-3 py-4 text-center text-xs text-muted-foreground">{{ t("queryDesigner.noColumns") }}</div>
    </div>
    <div class="flex shrink-0 flex-wrap items-center gap-1 border-t px-2 py-1">
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="emit('change', addCustomExpressionColumn(state, uuid))"><Plus class="mr-1 h-3.5 w-3.5" />{{ t("queryDesigner.addExpression") }}</Button>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="emit('change', setOrFilterCount(state, (state.orFilterCount ?? 0) + 1))"><Plus class="mr-1 h-3.5 w-3.5" />{{ t("queryDesigner.addOrFilter") }}</Button>
      <Button v-if="state.orFilterCount" variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="emit('change', setOrFilterCount(state, state.orFilterCount - 1))"><Minus class="mr-1 h-3.5 w-3.5" />{{ t("queryDesigner.removeOrFilter") }}</Button>
      <template v-if="grouped">
        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="emit('change', setOrFilterCount(state, (state.groupOrFilterCount ?? 0) + 1, true))"><Plus class="mr-1 h-3.5 w-3.5" />{{ t("queryDesigner.addGroupOrFilter") }}</Button>
        <Button v-if="state.groupOrFilterCount" variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="emit('change', setOrFilterCount(state, state.groupOrFilterCount - 1, true))"><Minus class="mr-1 h-3.5 w-3.5" />{{ t("queryDesigner.removeGroupOrFilter") }}</Button>
      </template>
    </div>
  </div>
</template>
