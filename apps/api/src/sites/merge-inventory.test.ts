import { describe, expect, it } from "vitest";
import { mergeInventoryUpdates } from "./operations";

const item = (
  name: string,
  version: string,
  updateVersion: string | null,
): {
  name: string;
  title: string;
  status: "active";
  version: string;
  updateVersion: string | null;
} => ({ name, title: name, status: "active", version, updateVersion });

describe("mergeInventoryUpdates", () => {
  it("keeps prior updateVersion when the installed version is unchanged", () => {
    const fresh = [item("akismet", "5.0", null), item("hello", "1.0", null)];
    const previous = [item("akismet", "5.0", "5.1"), item("hello", "1.0", null)];
    expect(mergeInventoryUpdates(fresh, previous)).toEqual([
      item("akismet", "5.0", "5.1"),
      item("hello", "1.0", null),
    ]);
  });

  it("drops stale update flags when the installed version changed", () => {
    const fresh = [item("akismet", "5.1", null)];
    const previous = [item("akismet", "5.0", "5.1")];
    expect(mergeInventoryUpdates(fresh, previous)).toEqual([item("akismet", "5.1", null)]);
  });

  it("returns fresh rows when there is no previous inventory", () => {
    const fresh = [item("akismet", "5.0", null)];
    expect(mergeInventoryUpdates(fresh, [])).toEqual(fresh);
  });
});
