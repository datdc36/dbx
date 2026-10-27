<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { EllipsisVertical, Filter, X } from "@lucide/vue";
import LightDropdownMenu, { type LightDropdownMenuItem } from "@/components/ui/LightDropdownMenu.vue";
import { DATA_GRID_FILTER_ROW_DATE_PRESET_GROUPS, defaultDataGridFilterRowMode, isDataGridFilterRowFilterActive, type DataGridFilterRowColumnKind, type DataGridFilterRowDatePreset, type DataGridFilterRowFilter } from "@/lib/dataGrid/dataGridFilterRow";
import { dataGridFilterRowFilterToExpression, dataGridFilterSyntaxBehaviour, dataGridFilterSyntaxError, dataGridFilterSyntaxFeatures, dataGridFilterSyntaxMultipleValues } from "@/lib/dataGrid/dataGridFilterSyntax";

/*
 * Filter row cell for the "expression" filter row style: the box text is the filter
 * (`>10 <20`, `^ab, $yz`, `NULL`, `TODAY`, `{$$ > 5}` …). The ⋮ menu writes expressions
 * instead of switching an operator.
 */

const CLEAR = "__clear";
const PRESET_KEYWORDS: Record<DataGridFilterRowDatePreset, string> = {
  tomorrow: "TOMORROW",
  today: "TODAY",
  yesterday: "YESTERDAY",
  "next-week": "NEXT WEEK",
  "this-week": "THIS WEEK",
  "last-week": "LAST WEEK",
  "next-month": "NEXT MONTH",
  "this-month": "THIS MONTH",
  "last-month": "LAST MONTH",
  "next-year": "NEXT YEAR",
  "this-year": "THIS YEAR",
  "last-year": "LAST YEAR",
};

function presetLabelKey(preset: DataGridFilterRowDatePreset): string {
  return `grid.filterRowPreset.${preset.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())}`;
}

/** A menu entry: `set` replaces the filter and applies it, `insert` starts an expression for the user to finish. */
interface SyntaxMenuEntry {
  labelKey: string;
  set?: string;
  insert?: string;
  /** Caret offset inside `insert` (defaults to its end). */
  caret?: number;
  separatorBefore?: boolean;
}

const props = defineProps<{
  filter?: DataGridFilterRowFilter;
  kind: DataGridFilterRowColumnKind;
  canPickValues?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  change: [filter: DataGridFilterRowFilter | null];
  pickValues: [];
  focusGrid: [];
}>();

const { t } = useI18n();

const behaviour = computed(() => dataGridFilterSyntaxBehaviour(props.kind));
const inputRef = ref<HTMLInputElement | null>(null);
const draft = ref(boxText(props.filter));
const menuOpen = ref(false);

watch(
  () => [props.filter, behaviour.value] as const,
  ([filter]) => {
    draft.value = boxText(filter);
  },
);

/** A value + operator filter (made before switching syntax) is shown as its equivalent expression. */
function boxText(filter: DataGridFilterRowFilter | undefined): string {
  if (!filter) return "";
  return dataGridFilterRowFilterToExpression(filter, behaviour.value) ?? filter.rawValue;
}

const error = computed(() => dataGridFilterSyntaxError(draft.value, behaviour.value));
const isValid = computed(() => !!draft.value.trim() && !error.value);
const isActive = computed(() => isDataGridFilterRowFilterActive(props.filter));
const title = computed(() => (error.value ? t("grid.filterSyntaxInvalid", { message: error.value.message }) : isValid.value ? undefined : t("grid.filterSyntaxHint")));

const menuEntries = computed<SyntaxMenuEntry[]>(() => {
  const features = dataGridFilterSyntaxFeatures(behaviour.value);
  const entries: SyntaxMenuEntry[] = [];
  const group = (items: SyntaxMenuEntry[]) => entries.push(...items.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item)));
  if (features.supportEquals) {
    group([
      { labelKey: "grid.filterBuilderEquals", insert: "=" },
      { labelKey: "grid.filterBuilderNotEquals", insert: "<>" },
    ]);
  }
  if (features.supportNullTesting) {
    group([
      { labelKey: "grid.filterBuilderIsNull", set: "NULL" },
      { labelKey: "grid.filterBuilderIsNotNull", set: "NOT NULL" },
    ]);
  }
  if (features.supportNumberLikeComparison) {
    group([
      { labelKey: "grid.filterBuilderGreaterThan", insert: ">" },
      { labelKey: "grid.filterBuilderGreaterThanOrEqual", insert: ">=" },
      { labelKey: "grid.filterBuilderLessThan", insert: "<" },
      { labelKey: "grid.filterBuilderLessThanOrEqual", insert: "<=" },
    ]);
  }
  if (features.supportStringInclusion) {
    group([
      { labelKey: "grid.filterBuilderContains", insert: "+" },
      { labelKey: "grid.filterBuilderNotContains", insert: "~" },
      { labelKey: "grid.filterBuilderBeginsWith", insert: "^" },
      { labelKey: "grid.filterBuilderNotBeginsWith", insert: "!^" },
      { labelKey: "grid.filterBuilderEndsWith", insert: "$" },
      { labelKey: "grid.filterBuilderNotEndsWith", insert: "!$" },
    ]);
  }
  if (features.supportEmpty) {
    group([
      { labelKey: "grid.filterBuilderIsEmpty", set: "EMPTY" },
      { labelKey: "grid.filterBuilderIsNotEmpty", set: "NOT EMPTY" },
    ]);
  }
  if (features.supportBooleanValues) {
    group([
      { labelKey: "grid.filterRowIsTrue", set: "TRUE" },
      { labelKey: "grid.filterRowIsFalse", set: "FALSE" },
      ...(features.supportNullTesting
        ? [
            { labelKey: "grid.filterRowIsTrueOrNull", set: "TRUE, NULL" },
            { labelKey: "grid.filterRowIsFalseOrNull", set: "FALSE, NULL" },
          ]
        : []),
    ]);
  }
  if (features.supportDatetimeSymbols) {
    for (const presets of DATA_GRID_FILTER_ROW_DATE_PRESET_GROUPS) group(presets.map((preset) => ({ labelKey: presetLabelKey(preset), set: PRESET_KEYWORDS[preset] })));
  }
  if (features.supportDatetimeComparison) {
    group([
      { labelKey: "grid.filterRowOnOrBefore", insert: "<=" },
      { labelKey: "grid.filterRowOnOrAfter", insert: ">=" },
      { labelKey: "grid.filterBuilderBetween", insert: ">= <=", caret: 2 },
    ]);
  }
  if (features.supportSqlCondition) {
    group([
      { labelKey: "grid.filterRowSqlCondition", insert: "{}", caret: 1 },
      { labelKey: "grid.filterRowSqlConditionRight", insert: "{$$ }", caret: 4 },
    ]);
  }
  return entries;
});

const menuItems = computed<LightDropdownMenuItem[]>(() => [
  { label: t("grid.clearFilter"), value: CLEAR, icon: X, disabled: !props.filter && !draft.value },
  ...menuEntries.value.map((entry, index) => ({ label: entry.insert !== undefined ? `${t(entry.labelKey)}…` : t(entry.labelKey), value: String(index), separatorBefore: entry.separatorBefore })),
]);

function commit() {
  const text = draft.value;
  if (!text.trim()) {
    if (props.filter) emit("change", null);
    return;
  }
  if (error.value) return;
  if (text.trim() === boxText(props.filter).trim()) return;
  emit("change", { mode: defaultDataGridFilterRowMode(props.kind), rawValue: "", rawEndValue: "", expression: text });
}

function clear() {
  draft.value = "";
  if (props.filter) emit("change", null);
}

async function selectMenuItem(value: string) {
  if (value === CLEAR) return clear();
  const entry = menuEntries.value[Number(value)];
  if (!entry) return;
  if (entry.set !== undefined) {
    draft.value = entry.set;
    commit();
    return;
  }
  const snippet = entry.insert ?? "";
  draft.value = snippet;
  await nextTick();
  const caret = entry.caret ?? snippet.length;
  inputRef.value?.focus();
  inputRef.value?.setSelectionRange(caret, caret);
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

/** Multi-line paste: each non-empty line is one value, matched as "is any of" (`="a", ="b"`). */
function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!/[\r\n]/.test(text)) return;
  const expression = dataGridFilterSyntaxMultipleValues("is", text, behaviour.value);
  if (!expression) return;
  event.preventDefault();
  draft.value = expression;
  commit();
}
</script>

<template>
  <div class="flex h-full min-w-0 items-center gap-0.5 px-1" @mousedown.stop @pointerdown.stop>
    <input
      ref="inputRef"
      v-model="draft"
      type="text"
      class="h-5 min-w-0 flex-1 rounded-sm border bg-background px-1.5 font-mono text-xs font-normal outline-none placeholder:font-sans placeholder:text-muted-foreground/70 focus:border-ring disabled:opacity-60"
      :class="error ? 'border-destructive/70 bg-destructive/10' : isValid ? 'border-emerald-500/70 bg-emerald-500/5' : 'border-border'"
      :placeholder="t('grid.filterRowPlaceholder')"
      :disabled="disabled"
      :title="title"
      :aria-invalid="!!error"
      spellcheck="false"
      autocomplete="off"
      @keydown="onKeydown"
      @blur="commit()"
      @paste="onPaste"
    />
    <button v-if="isActive || draft" type="button" class="flex h-5 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" :title="t('grid.clearFilter')" :disabled="disabled" @click.stop="clear">
      <X class="h-3 w-3" />
    </button>
    <LightDropdownMenu
      :items="menuItems"
      :open="menuOpen"
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
