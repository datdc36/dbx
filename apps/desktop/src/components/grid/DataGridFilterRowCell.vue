<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { EllipsisVertical, Filter, X } from "@lucide/vue";
import LightDropdownMenu, { type LightDropdownMenuItem } from "@/components/ui/LightDropdownMenu.vue";
import { filterModeNeedsValue, filterModeUsesList, filterModeUsesRange, formatFilterRawValues } from "@/lib/dataGrid/dataGridColumnFilter";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import {
  DATA_GRID_FILTER_ROW_DATE_PRESET_GROUPS,
  dataGridFilterRowModeApplies,
  dataGridFilterRowPastedValues,
  defaultDataGridFilterRowMode,
  isDataGridFilterRowFilterActive,
  type DataGridFilterRowColumnKind,
  type DataGridFilterRowDatePreset,
  type DataGridFilterRowFilter,
} from "@/lib/dataGrid/dataGridFilterRow";

const CLEAR = "__clear";
const PRESET_PREFIX = "preset:";

/** Date columns get DbGate-style wording: a date-only value always means the whole day. */
const DATETIME_MODE_LABEL_KEYS: Partial<Record<DataGridContextFilterMode, string>> = {
  equals: "grid.filterRowOnDate",
  "less-than-or-equal": "grid.filterRowOnOrBefore",
  "greater-than-or-equal": "grid.filterRowOnOrAfter",
  between: "grid.filterBuilderBetween",
  "is-null": "grid.filterBuilderIsNull",
  "is-not-null": "grid.filterBuilderIsNotNull",
};
const DATETIME_VALUE_MODES: DataGridContextFilterMode[] = ["equals", "less-than-or-equal", "greater-than-or-equal", "between"];

function presetLabelKey(preset: DataGridFilterRowDatePreset): string {
  return `grid.filterRowPreset.${preset.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())}`;
}

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
const draftValue = ref(boxText(props.filter));
const draftEndValue = ref(props.filter?.rawEndValue ?? "");
const preset = ref<DataGridFilterRowDatePreset | undefined>(props.filter?.preset);
const menuOpen = ref(false);

watch(
  () => props.filter,
  (filter) => {
    mode.value = filter?.mode ?? defaultDataGridFilterRowMode(props.kind);
    draftValue.value = boxText(filter);
    draftEndValue.value = filter?.rawEndValue ?? "";
    preset.value = filter?.preset;
  },
);

const applicableModes = computed(() => props.modeOptions.filter((option) => dataGridFilterRowModeApplies(option.value, props.kind)));
const needsValue = computed(() => !preset.value && filterModeNeedsValue(mode.value));
const usesRange = computed(() => !preset.value && filterModeUsesRange(mode.value));
const isActive = computed(() => isDataGridFilterRowFilterActive(props.filter));
function labelForMode(value: DataGridContextFilterMode): string {
  const dateKey = props.kind === "datetime" ? DATETIME_MODE_LABEL_KEYS[value] : undefined;
  if (dateKey) return t(dateKey);
  const option = props.modeOptions.find((candidate) => candidate.value === value);
  return option ? t(option.labelKey) : value;
}
const modeLabel = computed(() => (preset.value ? t(presetLabelKey(preset.value)) : labelForMode(mode.value)));
const placeholder = computed(() => {
  if (!props.filter && mode.value === defaultDataGridFilterRowMode(props.kind)) return t("grid.filterRowPlaceholder");
  return filterModeUsesList(mode.value) ? `${modeLabel.value}: a, b, c` : modeLabel.value;
});
const datetimeMenuItems = computed<LightDropdownMenuItem[]>(() => [
  { label: t("grid.clearFilter"), value: CLEAR, icon: X, disabled: !props.filter },
  ...(["is-null", "is-not-null"] as const).map((value, index) => ({ label: labelForMode(value), value, separatorBefore: index === 0, checked: !preset.value && mode.value === value })),
  ...DATA_GRID_FILTER_ROW_DATE_PRESET_GROUPS.flatMap((group) => group.map((value, index) => ({ label: t(presetLabelKey(value)), value: `${PRESET_PREFIX}${value}`, separatorBefore: index === 0, checked: preset.value === value }))),
  ...DATETIME_VALUE_MODES.map((value, index) => ({ label: `${labelForMode(value)}…`, value, separatorBefore: index === 0, checked: !preset.value && mode.value === value })),
]);
const menuItems = computed<LightDropdownMenuItem[]>(() =>
  props.kind === "datetime"
    ? datetimeMenuItems.value
    : [{ label: t("grid.clearFilter"), value: CLEAR, icon: X, disabled: !props.filter }, ...applicableModes.value.map((option, index) => ({ label: t(option.labelKey), value: option.value, separatorBefore: index === 0, checked: option.value === mode.value }))],
);

/** What the box shows: the typed value, or the name of a preset / value-less operator as editable text. */
function boxText(filter: DataGridFilterRowFilter | undefined): string {
  if (!filter) return "";
  if (filter.preset) return t(presetLabelKey(filter.preset));
  if (!filterModeNeedsValue(filter.mode)) return labelForMode(filter.mode);
  return filter.rawValue;
}

/** Text typed in the box that names a preset or a value-less operator ("today", "is null" …). */
function keywordFor(text: string): { preset?: DataGridFilterRowDatePreset; mode?: DataGridContextFilterMode } | undefined {
  const typed = text.trim().toLocaleLowerCase();
  if (!typed) return undefined;
  if (props.kind === "datetime") {
    const matched = DATA_GRID_FILTER_ROW_DATE_PRESET_GROUPS.flat().find((candidate) => t(presetLabelKey(candidate)).toLocaleLowerCase() === typed);
    if (matched) return { preset: matched };
  }
  const valueless = props.kind === "datetime" ? (["is-null", "is-not-null"] as DataGridContextFilterMode[]) : applicableModes.value.map((option) => option.value).filter((value) => !filterModeNeedsValue(value));
  const matchedMode = valueless.find((candidate) => labelForMode(candidate).toLocaleLowerCase() === typed);
  return matchedMode ? { mode: matchedMode } : undefined;
}

function commit(nextMode = mode.value) {
  if (preset.value) {
    if (props.filter?.preset !== preset.value) emit("change", { mode: "between", rawValue: "", rawEndValue: "", preset: preset.value });
    return;
  }
  const filter: DataGridFilterRowFilter = { mode: nextMode, rawValue: filterModeNeedsValue(nextMode) ? draftValue.value : "", rawEndValue: filterModeUsesRange(nextMode) ? draftEndValue.value : "" };
  if (!isDataGridFilterRowFilterActive(filter)) {
    if (props.filter) emit("change", null);
    return;
  }
  if (props.filter && !props.filter.preset && props.filter.mode === filter.mode && props.filter.rawValue === filter.rawValue && props.filter.rawEndValue === filter.rawEndValue) return;
  emit("change", filter);
}

function clear() {
  draftValue.value = "";
  draftEndValue.value = "";
  preset.value = undefined;
  mode.value = defaultDataGridFilterRowMode(props.kind);
  if (props.filter) emit("change", null);
}

function selectMenuItem(value: string) {
  if (value === CLEAR) return clear();
  if (value.startsWith(PRESET_PREFIX)) {
    preset.value = value.slice(PRESET_PREFIX.length) as DataGridFilterRowDatePreset;
    mode.value = "between";
    draftValue.value = t(presetLabelKey(preset.value));
    commit();
    return;
  }
  const showedLabel = !!preset.value || !filterModeNeedsValue(mode.value);
  preset.value = undefined;
  mode.value = value as DataGridContextFilterMode;
  if (!filterModeNeedsValue(mode.value)) draftValue.value = labelForMode(mode.value);
  else if (showedLabel) draftValue.value = "";
  // Value-less operators (is null …) apply at once; the others wait for a value.
  commit(mode.value);
}

/** The box is plain text: a preset or operator name selects it, anything else is a value. */
function onInput() {
  const keyword = keywordFor(draftValue.value);
  if (keyword?.preset) {
    preset.value = keyword.preset;
    mode.value = "between";
  } else if (keyword?.mode) {
    preset.value = undefined;
    mode.value = keyword.mode;
  } else if (preset.value || !filterModeNeedsValue(mode.value)) {
    preset.value = undefined;
    mode.value = defaultDataGridFilterRowMode(props.kind);
  }
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
  preset.value = undefined;
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
      :disabled="disabled"
      :title="isActive ? modeLabel : undefined"
      spellcheck="false"
      autocomplete="off"
      @input="onInput"
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
    <button v-if="isActive" type="button" class="flex h-5 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" :title="t('grid.clearFilter')" :disabled="disabled" @click.stop="clear">
      <X class="h-3 w-3" />
    </button>
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
