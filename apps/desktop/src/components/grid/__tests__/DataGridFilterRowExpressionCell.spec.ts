// @vitest-environment happy-dom

import { createApp, h, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import en from "@/i18n/locales/en";
import DataGridFilterRowExpressionCell from "../DataGridFilterRowExpressionCell.vue";
import type { DataGridFilterRowColumnKind, DataGridFilterRowFilter } from "@/lib/dataGrid/dataGridFilterRow";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function mountCell(filter: DataGridFilterRowFilter | undefined, kind: DataGridFilterRowColumnKind = "number") {
  const changes: Array<DataGridFilterRowFilter | null> = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(DataGridFilterRowExpressionCell, { filter, kind, onChange: (next: DataGridFilterRowFilter | null) => changes.push(next) }),
  });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en } })).mount(host);
  mountedApps.push({ app, host });
  return { host, changes, input: host.querySelector("input") as HTMLInputElement };
}

async function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await nextTick();
}

function key(input: HTMLInputElement, name: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGridFilterRowExpressionCell", () => {
  it("applies a valid expression on Enter", async () => {
    const { input, changes } = mountCell(undefined);
    await type(input, ">10 <20");
    key(input, "Enter");
    expect(changes).toEqual([{ mode: "equals", rawValue: "", rawEndValue: "", expression: ">10 <20" }]);
  });

  it("marks an invalid expression and does not apply it", async () => {
    const { input, changes } = mountCell(undefined);
    await type(input, "abc");
    key(input, "Enter");
    input.dispatchEvent(new Event("blur"));
    expect(changes).toEqual([]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.title).toContain("position 1");
  });

  it("clears on Escape", async () => {
    const { input, changes } = mountCell({ mode: "equals", rawValue: "", rawEndValue: "", expression: ">1" });
    expect(input.value).toBe(">1");
    key(input, "Escape");
    await nextTick();
    expect(input.value).toBe("");
    expect(changes).toEqual([null]);
  });

  it("shows a value + operator filter as its expression and keeps it until edited", async () => {
    const { input, changes } = mountCell({ mode: "begins-with", rawValue: "ab", rawEndValue: "" }, "text");
    expect(input.value).toBe('^"ab"');
    key(input, "Enter");
    expect(changes).toEqual([]);
    await type(input, '^"ab" $z');
    key(input, "Enter");
    expect(changes).toEqual([{ mode: "like", rawValue: "", rawEndValue: "", expression: '^"ab" $z' }]);
  });

  it("turns pasted lines into an any-of expression", async () => {
    const { input, changes } = mountCell(undefined, "text");
    const event = new Event("paste", { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "a\nb\n" } });
    input.dispatchEvent(event);
    await nextTick();
    expect(event.defaultPrevented).toBe(true);
    expect(changes).toEqual([{ mode: "like", rawValue: "", rawEndValue: "", expression: '="a", ="b"' }]);
  });
});
