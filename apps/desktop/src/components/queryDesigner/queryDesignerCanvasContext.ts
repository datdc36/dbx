import type { ComputedRef, InjectionKey } from "vue";
import type { ContextMenuItem } from "@/components/ui/customContextMenuRegistry";
import type { QueryDesignerColumnRef, QueryDesignerReference, QueryDesignerState } from "@/lib/queryDesigner/queryDesignerModel";

/** What the canvas offers its table nodes and join edges (Vue Flow renders them outside our props). */
export interface QueryDesignerCanvasContext {
  state: ComputedRef<QueryDesignerState>;
  toggleOutput(ref: QueryDesignerColumnRef): void;
  tableMenuItems(designerId: string): ContextMenuItem[];
  columnMenuItems(ref: QueryDesignerColumnRef): ContextMenuItem[];
  referenceMenuItems(reference: QueryDesignerReference): ContextMenuItem[];
  removeTable(designerId: string): void;
}

export const QUERY_DESIGNER_CANVAS_KEY: InjectionKey<QueryDesignerCanvasContext> = Symbol("query-designer-canvas");

/** Column handles are `<side>:<column>`; the side keeps edges on the facing edges of two cards. */
export function columnHandleId(side: "left" | "right", columnName: string): string {
  return `${side}:${columnName}`;
}

export function columnFromHandleId(handleId: string | null | undefined): string | undefined {
  if (!handleId) return undefined;
  const separator = handleId.indexOf(":");
  return separator < 0 ? undefined : handleId.slice(separator + 1);
}

export const QUERY_DESIGNER_CARD_WIDTH = 240;
