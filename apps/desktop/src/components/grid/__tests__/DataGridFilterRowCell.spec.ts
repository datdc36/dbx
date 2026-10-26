// @vitest-environment happy-dom

import { createApp, h, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import en from "@/i18n/locales/en";
import DataGridFilterRowCell from "../DataGridFilterRowCell.vue";
import type { DataGridFilterRowFilter } from "@/lib/dataGrid/dataGridFilterRow";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function mountCell(filter: DataGridFilterRowFilter | undefined) {
  const changes: Array<DataGridFilterRowFilter | null> = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    render: () =>
      h(DataGridFilterRowCell, {
        filter,
        kind: "datetime",
        modeOptions: [
          { value: "equals", labelKey: "grid.filterBuilderEquals" },
          { value: "between", labelKey: "grid.filterBuilderBetween" },
        ],
        onChange: (next: DataGridFilterRowFilter | null) => changes.push(next),
      }),
  });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en } })).mount(host);
  mountedApps.push({ app, host });
  return { host, changes, input: host.querySelector("input") as HTMLInputElement };
}

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input"));
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

const thisMonth: DataGridFilterRowFilter = { mode: "between", rawValue: "", rawEndValue: "", preset: "this-month" };

describe("DataGridFilterRowCell with a date preset", () => {
  it("shows the preset name as editable text", () => {
    const { input } = mountCell(thisMonth);
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("This Month");
  });

  it("replaces the preset with a typed date on Enter", async () => {
    const { input, changes } = mountCell(thisMonth);
    type(input, "2026-10-01");
    await nextTick();
    key(input, "Enter");
    expect(changes).toEqual([{ mode: "equals", rawValue: "2026-10-01", rawEndValue: "" }]);
  });

  it("applies a preset typed by name", async () => {
    const { input, changes } = mountCell(undefined);
    type(input, "today");
    await nextTick();
    key(input, "Enter");
    expect(changes).toEqual([{ mode: "between", rawValue: "", rawEndValue: "", preset: "today" }]);
  });

  it("applies a value-less operator typed by name and shows it as text", async () => {
    const { input, changes } = mountCell(undefined);
    type(input, "is null");
    await nextTick();
    key(input, "Enter");
    expect(changes).toEqual([{ mode: "is-null", rawValue: "", rawEndValue: "" }]);
  });

  it("clears the filter when the text is deleted", async () => {
    const { input, changes } = mountCell(thisMonth);
    type(input, "");
    await nextTick();
    key(input, "Enter");
    expect(changes).toEqual([null]);
  });

  it("offers a clear button while a filter is active", async () => {
    const { host, changes } = mountCell(thisMonth);
    const clear = host.querySelector('button[title="Clear Filter"]') as HTMLButtonElement;
    expect(clear).not.toBeNull();
    clear.click();
    await nextTick();
    expect(changes).toEqual([null]);
  });

  it("shows no clear button without a filter", () => {
    const { host } = mountCell(undefined);
    expect(host.querySelector('button[title="Clear Filter"]')).toBeNull();
  });
});
