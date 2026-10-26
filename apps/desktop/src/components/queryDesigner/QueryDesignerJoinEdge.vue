<script setup lang="ts">
import { computed, inject } from "vue";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@vue-flow/core";
import CustomContextMenu from "@/components/ui/CustomContextMenu.vue";
import type { QueryDesignerReference } from "@/lib/queryDesigner/queryDesignerModel";
import { QUERY_DESIGNER_CANVAS_KEY } from "./queryDesignerCanvasContext";

/** One edge per column pair; only the reference's first pair carries the join label. */
const props = defineProps<EdgeProps<{ reference: QueryDesignerReference; showLabel: boolean }>>();

const designer = inject(QUERY_DESIGNER_CANVAS_KEY)!;

const geometry = computed(() =>
  getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  }),
);
const reference = computed(() => props.data!.reference);
const isCross = computed(() => reference.value.joinType === "cross-join");
const label = computed(() => reference.value.joinType.toUpperCase().replaceAll("-", " "));
</script>

<template>
  <BaseEdge :id="id" :path="geometry[0]" :interaction-width="20" :style="{ stroke: isCross ? 'var(--muted-foreground)' : 'var(--primary)', strokeWidth: 1.5, strokeDasharray: isCross ? '4 4' : undefined }" />
  <EdgeLabelRenderer v-if="data?.showLabel">
    <CustomContextMenu :items="() => designer.referenceMenuItems(reference)" v-slot="{ onContextMenu }">
      <button
        type="button"
        class="nopan nodrag pointer-events-auto absolute z-10 rounded border bg-background/95 px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none shadow-sm hover:border-primary"
        :style="{ transform: `translate(-50%, -50%) translate(${geometry[1]}px, ${geometry[2]}px)` }"
        @click="onContextMenu"
        @contextmenu="onContextMenu"
      >
        {{ label }}
      </button>
    </CustomContextMenu>
  </EdgeLabelRenderer>
</template>
