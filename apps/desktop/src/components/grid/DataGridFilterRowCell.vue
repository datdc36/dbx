<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { EllipsisVertical, Filter, X } from "@lucide/vue";
import LightDropdownMenu, { type LightDropdownMenuItem } from "@/components/ui/LightDropdownMenu.vue";
import { filterModeNeedsValue, filterModeUsesList, filterModeUsesRange, formatFilterRawValues } from "@/lib/dataGrid/dataGridColumnFilter";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import { dataGridFilterRowModeApplies, dataGridFilterRowPastedValues, defaultDataGridFilterRowMode, isDataGridFilterRowFilterActive, type DataGridFilterRowColumnKind, type DataGridFilterRowFilter } from "@/lib/dataGrid/dataGridFilterRow";

const CLEAR = "__clear";

const props = defineProps<{
  /** The applied filter for this column, if any. */
  filter?: DataGridFilterRowFilter;
  kind: DataGridFilterRowColumnKind;
  modeOptions: readonly { value: DataGridContextFilterMode; labelKey: string }[];
  canPickValues?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  /** Committed on Enter, blur or operator change; `null` clears the column. */
  change: [filter: DataGridFilterRowFilter | null];
  pickValues: [];
  /** ↓ from the box hands keyboard focus back to the grid body. */
  focusGrid: [];
}>();

const { t } = useI18n();

const mode = ref<DataGridContextFilterMode>(props.filter?.mode ?? defaultDataGridFilterRowMode(props.kind));
const draftValue = ref(props.filter?.rawValue ?? "");
const draftEndValue = ref(props.filter?.rawEndValue ?? "");
const menuOpen = ref(false);

watch(
  () => props.filter,
  (filter) => {
    mode.value = filter?.mode ?? defaultDataGridFilterRowMode(props.kind);
    draftValue.value = filter?.rawValue ?? "";
    draftEndValue.value = filter?.rawEndValue ?? "";
  },
);

const applicableModes = computed(() => props.modeOptions.filter((option) => dataGridFilterRowModeApplies(option.value, props.kind)));
const needsValue = computed(() => filterModeNeedsValue(mode.value));
const usesRange = computed(() => filterModeUsesRange(mode.value));
const isActive = computed(() => isDataGridFilterRowFilterActive(props.filter));
const modeLabel = computed(() => {
  const option = props.modeOptions.find((candidate) => candidate.value === mode.value);
  return option ? t(option.labelKey) : mode.value;
});
const placeholder = computed(() => {
  if (!props.filter && mode.value === defaultDataGridFilterRowMode(props.kind)) return t("grid.filterRowPlaceholder");
  return filterModeUsesList(mode.value) ? `${modeLabel.value}: a, b, c` : modeLabel.value;
});
const menuItems = computed<LightDropdownMenuItem[]>(() => [
  { label: t("grid.clearFilter"), value: CLEAR, icon: X, disabled: !props.filter },
  ...applicableModes.value.map((option, index) => ({ label: t(option.labelKey), value: option.value, separatorBefore: index === 0, checked: option.value === mode.value })),
]);

function commit(nextMode = mode.value) {
  const filter: DataGridFilterRowFilter = { mode: nextMode, rawValue: filterModeNeedsValue(nextMode) ? draftValue.value : "", rawEndValue: filterModeUsesRange(nextMode) ? draftEndValue.value : "" };
  if (!isDataGridFilterRowFilterActive(filter)) {
    if (props.filter) emit("change", null);
    return;
  }
  if (props.filter && props.filter.mode === filter.mode && props.filter.rawValue === filter.rawValue && props.filter.rawEndValue === filter.rawEndValue) return;
  emit("change", filter);
}

function clear() {
  draftValue.value = "";
  draftEndValue.value = "";
  mode.value = defaultDataGridFilterRowMode(props.kind);
  if (props.filter) emit("change", null);
}

function selectMenuItem(value: string) {
  if (value === CLEAR) return clear();
  mode.value = value as DataGridContextFilterMode;
  // Value-less operators (is null …) apply at once; the others wait for a value.
  commit(mode.value);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault();
    commit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    clear();
  } else if (event.key === "ArrowDown" && !event.altKey) {
    event.preventDefault();
    emit("focusGrid");
  }
}

function onPaste(event: ClipboardEvent) {
  const values = dataGridFilterRowPastedValues(event.clipboardData?.getData("text/plain") ?? "");
  if (!values) return;
  event.preventDefault();
  mode.value = "in";
  draftValue.value = formatFilterRawValues(values);
  commit("in");
}
</script>

<template>
  <div class="flex h-full min-w-0 items-center gap-0.5 px-1" @mousedown.stop @pointerdown.stop>
    <input
      v-model="draftValue"
      type="text"
      class="h-5 min-w-0 flex-1 rounded-sm border bg-background px-1.5 text-xs font-normal outline-none placeholder:text-muted-foreground/70 focus:border-ring disabled:opacity-60"
      :class="isActive ? 'border-emerald-500/70 bg-emerald-500/5' : 'border-border'"
      :placeholder="needsValue ? placeholder : modeLabel"
      :disabled="disabled || !needsValue"
      :title="isActive ? modeLabel : undefined"
      spellcheck="false"
      autocomplete="off"
      @keydown="onKeydown"
      @blur="commit()"
      @paste="onPaste"
    />
    <input
      v-if="usesRange"
      v-model="draftEndValue"
      type="text"
      class="h-5 w-1/3 min-w-8 rounded-sm border border-border bg-background px-1.5 text-xs font-normal outline-none focus:border-ring"
      :placeholder="t('grid.filterRowRangeEnd')"
      :disabled="disabled"
      spellcheck="false"
      autocomplete="off"
      @keydown="onKeydown"
      @blur="commit()"
    />
    <LightDropdownMenu
      :items="menuItems"
      :open="menuOpen"
      :selected-value="mode"
      check-position="left"
      align="end"
      content-class="w-max min-w-36 p-0.5"
      item-class="gap-1 rounded-none px-1.5 py-0.5 text-xs"
      item-icon-class="h-3 w-3"
      :match-trigger-width="false"
      :disabled="disabled"
      @update:open="(value: boolean) => (menuOpen = value)"
      @select="selectMenuItem"
    >
      <template #trigger="{ open, toggle }">
        <button
          type="button"
          class="flex h-5 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          :class="isActive ? 'text-emerald-600 dark:text-emerald-400' : ''"
          :title="t('grid.filterRowOperator')"
          :aria-expanded="open"
          :disabled="disabled"
          @click.stop="toggle"
        >
          <EllipsisVertical class="h-3 w-3" />
        </button>
      </template>
    </LightDropdownMenu>
    <button v-if="canPickValues" type="button" class="flex h-5 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" :title="t('grid.filterRowPickValues')" :disabled="disabled" @click.stop="emit('pickValues')">
      <Filter class="h-3 w-3" />
    </button>
  </div>
</template>
