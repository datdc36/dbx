<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { filterModeNeedsValue, filterModeUsesList, filterModeUsesRange } from "@/lib/dataGrid/dataGridColumnFilter";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import { QUERY_DESIGNER_FILTER_MODE_OPTIONS, type QueryDesignerColumnFilter } from "@/lib/queryDesigner/queryDesignerModel";

const NO_FILTER = "__none";

const props = defineProps<{
  filter: QueryDesignerColumnFilter | null | undefined;
}>();

const emit = defineEmits<{
  change: [filter: QueryDesignerColumnFilter | null];
}>();

const { t } = useI18n();

function setMode(value: unknown) {
  const mode = String(value);
  if (mode === NO_FILTER) return emit("change", null);
  const next = { rawValue: "", rawEndValue: "", ...props.filter, mode: mode as DataGridContextFilterMode };
  if (!filterModeNeedsValue(next.mode)) next.rawValue = next.rawEndValue = "";
  else if (!filterModeUsesRange(next.mode)) next.rawEndValue = "";
  emit("change", next);
}

function setValue(key: "rawValue" | "rawEndValue", value: string | number | undefined) {
  if (!props.filter) return;
  emit("change", { ...props.filter, [key]: String(value ?? "") });
}
</script>

<template>
  <div class="flex min-w-48 items-center gap-1">
    <Select :model-value="filter?.mode ?? NO_FILTER" @update:model-value="setMode">
      <SelectTrigger size="sm" class="h-7 w-28 shrink-0 px-2 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem :value="NO_FILTER" class="text-xs">{{ t("queryDesigner.none") }}</SelectItem>
        <SelectItem v-for="option in QUERY_DESIGNER_FILTER_MODE_OPTIONS" :key="option.value" :value="option.value" class="text-xs">{{ t(option.labelKey) }}</SelectItem>
      </SelectContent>
    </Select>
    <template v-if="filter && filterModeNeedsValue(filter.mode)">
      <Input class="h-7 min-w-16 flex-1 px-2 text-xs" :model-value="filter.rawValue" :placeholder="filterModeUsesList(filter.mode) ? t('queryDesigner.listPlaceholder') : t('queryDesigner.valuePlaceholder')" @update:model-value="(value) => setValue('rawValue', value)" />
      <Input v-if="filterModeUsesRange(filter.mode)" class="h-7 min-w-16 flex-1 px-2 text-xs" :model-value="filter.rawEndValue" :placeholder="t('queryDesigner.endValuePlaceholder')" @update:model-value="(value) => setValue('rawEndValue', value)" />
    </template>
  </div>
</template>
