import { describe, expect, it } from "vitest";
import { normalise, parseJsonArray } from "./inventory";

describe("parseJsonArray", () => {
  it("reads a plain array and ignores PHP noise around it", () => {
    expect(parseJsonArray('[{"name":"a","status":"active"}]')).toEqual([
      { name: "a", status: "active" },
    ]);
    expect(parseJsonArray('Notice: x\n[{"name":"a","status":"inactive"}]\nDone')).toEqual([
      { name: "a", status: "inactive" },
    ]);
  });

  it("repairs objects jammed together without commas", () => {
    const broken =
      '[{"name":"gallery-1","title":"Ads.txt Manager","status":"inactive","version":"1.4.5","update":"none","update_version":""} {"name":"slider-1","title":"Ads.txt Manager","status":"inactive","version":"1.4.5","update":"none","update_version":""}]';
    expect(parseJsonArray(broken)).toHaveLength(2);
  });
});

describe("normalise", () => {
  it("keeps known statuses and records odd rows as skipped", () => {
    const result = normalise(
      [
        { name: "ok", status: "active", title: "OK", version: "1", update: "none" },
        { name: "weird", status: "surprise", title: "", version: "1", update: "none" },
      ],
      ["broken-row"],
    );
    expect(result.items).toEqual([
      { name: "ok", title: "OK", status: "active", version: "1", updateVersion: null },
    ]);
    expect(result.skipped).toEqual(["broken-row", "weird"]);
  });
});
