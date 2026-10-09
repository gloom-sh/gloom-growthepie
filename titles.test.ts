import { describe, expect, test } from "bun:test";
import manifest from "./gloom.json";
import plugin from "./index";

// The title a user sees is set in four places that must agree: the pane, the
// command-bar template, the shortcut the registry lists, and the report.
describe("titles", () => {
  test("the pane, the template and the listed shortcut share one title; the plugin keeps its directory name", () => {
    const pane = plugin.panes![0]!;
    const template = plugin.paneTemplates![0]!;
    const shortcut = manifest.contributes.shortcuts[0]!;
    expect(pane.name).toBe("Layer 2 Metrics");
    expect(template.label).toBe(pane.name);
    expect(shortcut.name).toBe(pane.name);
    expect(shortcut.code).toBe(template.shortcut!.prefix);
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.id).toBe(manifest.id);
  });

  test("the credit stays in the plugin description and the manifest", () => {
    expect(plugin.description).toContain("growthepie");
    expect(plugin.description).toContain("CC BY 4.0");
    expect(manifest.description).toContain("CC BY 4.0 from growthepie");
  });
});
