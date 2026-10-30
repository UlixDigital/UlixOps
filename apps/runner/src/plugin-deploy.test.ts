import { describe, expect, it } from "vitest";
import { extractPluginFiles } from "./plugin-deploy";

describe("extractPluginFiles", () => {
  it("accepts the registry layout slug/…", () => {
    const files = new Map<string, Buffer>([
      ["ulix-forms/ulix-forms.php", Buffer.from("<?php")],
      ["ulix-forms/includes/a.php", Buffer.from("a")],
    ]);
    const result = extractPluginFiles(files, "ulix-forms");
    expect(result).toMatchObject({ ok: true, kind: "dir" });
    if (result.ok && result.kind === "dir") {
      expect(result.files.map((f) => f.path).sort()).toEqual(["includes/a.php", "ulix-forms.php"]);
    }
  });

  it("accepts the snapshot layout plugin/slug/…", () => {
    const files = new Map<string, Buffer>([
      ["plugin/ulix-forms/ulix-forms.php", Buffer.from("<?php")],
      ["manifest.json", Buffer.from("{}")],
    ]);
    const result = extractPluginFiles(files, "ulix-forms");
    expect(result).toMatchObject({ ok: true, kind: "dir" });
  });

  it("refuses unexpected top-level folders", () => {
    const files = new Map<string, Buffer>([
      ["ulix-forms/a.php", Buffer.from("a")],
      ["other/b.php", Buffer.from("b")],
    ]);
    expect(extractPluginFiles(files, "ulix-forms")).toMatchObject({ ok: false });
  });
});
