import { describe, expect, it } from "vitest";
import {
  phpVersionCompare,
  matchVulnerabilities,
  severityFromCvss,
  softwareKey,
  toVulnRecord,
  versionInRange,
  type VulnRecord,
  VulnFeedResult,
  WordfenceRecord,
  worstSeverity,
} from "./vulnerabilities";

describe("phpVersionCompare (PHP version_compare)", () => {
  it.each([
    ["1.0", "1.0", 0],
    ["1.0", "1.0.0", -1],
    ["1.0.1", "1.0", 1],
    ["1.9", "1.10", -1],
    ["2.0", "10.0", -1],
    ["1.0rc1", "1.0", -1],
    ["1.0-beta", "1.0-alpha", 1],
    ["1.0-dev", "1.0-alpha", -1],
    ["1.0a", "1.0b", -1],
    ["1.0pl1", "1.0", 1],
    ["1.0RC2", "1.0rc1", 1],
    ["6.4.3", "6.4.10", -1],
    ["5.9", "5.9.0", -1],
    ["3.2.1", "3.2.1", 0],
    [" 1.2 ", "1.2", 0],
    ["1_2", "1.2", 0],
  ])("%s vs %s → %i", (a, b, expected) => {
    expect(phpVersionCompare(a, b)).toBe(expected);
    expect(phpVersionCompare(b, a)).toBe(expected === 0 ? 0 : -expected);
  });
});

describe("versionInRange", () => {
  const range = (from: string, fromInclusive: boolean, to: string, toInclusive: boolean) => ({
    from,
    fromInclusive,
    to,
    toInclusive,
  });

  it("treats * as open on that side", () => {
    expect(versionInRange("0.0.1", range("*", true, "3.0", true))).toBe(true);
    expect(versionInRange("99", range("2.0", true, "*", true))).toBe(true);
    expect(versionInRange("1.0", range("*", true, "*", true))).toBe(true);
  });

  it("respects inclusive and exclusive bounds", () => {
    expect(versionInRange("3.0", range("*", true, "3.0", true))).toBe(true);
    expect(versionInRange("3.0", range("*", true, "3.0", false))).toBe(false);
    expect(versionInRange("2.0", range("2.0", false, "3.0", true))).toBe(false);
    expect(versionInRange("2.0", range("2.0", true, "3.0", true))).toBe(true);
    expect(versionInRange("3.0.1", range("*", true, "3.0", true))).toBe(false);
  });
});

describe("severityFromCvss", () => {
  it.each([
    [9.8, "critical"],
    [9, "critical"],
    [7.5, "high"],
    [5.3, "medium"],
    [3.1, "low"],
    [0, "unknown"],
    [null, "unknown"],
  ] as const)("%s → %s", (score, severity) => {
    expect(severityFromCvss(score)).toBe(severity);
  });
});

const raw = (over: Record<string, unknown> = {}) =>
  WordfenceRecord.parse({
    id: "0a1b2c3d-1111-2222-3333-444455556666",
    title: "Contact Form <= 5.1 - Reflected XSS",
    software: [
      {
        type: "plugin",
        name: "Contact Form",
        slug: "Contact-Form",
        affected_versions: {
          "* - 5.1": {
            from_version: "*",
            from_inclusive: true,
            to_version: "5.1",
            to_inclusive: true,
          },
        },
        patched: true,
        patched_versions: ["5.2", "4.9.9"],
      },
      {
        type: "plugin",
        name: "Other",
        slug: "not-installed",
        affected_versions: {},
      },
    ],
    informational: false,
    references: [
      "https://nvd.nist.gov/vuln/detail/CVE-2024-12345",
      "https://www.wordfence.com/threat-intel/vulnerabilities/id/0a1b",
    ],
    published: "2024-05-01 12:00:00",
    cve: "CVE-2024-12345",
    cvss: { score: 6.1, rating: "Medium", vector: "CVSS:3.1/..." },
    description: "ignored",
    ...over,
  });

const wanted = new Set([softwareKey("plugin", "contact-form"), softwareKey("core", "wordpress")]);

describe("toVulnRecord", () => {
  it("keeps only wanted software and the fields we use", () => {
    const record = toVulnRecord(raw(), wanted);
    expect(record).toEqual({
      id: "0a1b2c3d-1111-2222-3333-444455556666",
      title: "Contact Form <= 5.1 - Reflected XSS",
      severity: "medium",
      cvssScore: 6.1,
      cve: "CVE-2024-12345",
      reference: "https://www.wordfence.com/threat-intel/vulnerabilities/id/0a1b",
      publishedAt: "2024-05-01T12:00:00.000Z",
      software: [
        {
          type: "plugin",
          slug: "contact-form",
          ranges: [{ from: "*", fromInclusive: true, to: "5.1", toInclusive: true }],
          patchedVersions: ["5.2", "4.9.9"],
        },
      ],
    });
  });

  it("drops informational records and records about software we don't run", () => {
    expect(toVulnRecord(raw({ informational: true }), wanted)).toBeNull();
    expect(toVulnRecord(raw(), new Set(["plugin:something-else"]))).toBeNull();
  });

  it("falls back to the CVSS score when the rating is missing", () => {
    expect(toVulnRecord(raw({ cvss: { score: 9.8 } }), wanted)?.severity).toBe("critical");
    expect(toVulnRecord(raw({ cvss: null }), wanted)?.severity).toBe("unknown");
  });

  it("drops malformed CVE ids and non-https references", () => {
    const record = toVulnRecord(
      raw({ cve: "not-a-cve", references: ["http://example.test/x", "javascript:alert(1)"] }),
      wanted,
    );
    expect(record?.cve).toBeNull();
    expect(record?.reference).toBeNull();
  });

  it("skips software entries with unknown types or bad slugs", () => {
    const record = toVulnRecord(
      raw({
        software: [
          { type: "library", slug: "contact-form", affected_versions: {} },
          { type: "plugin", slug: "../etc", affected_versions: {} },
        ],
      }),
      wanted,
    );
    expect(record).toBeNull();
  });
});

describe("matchVulnerabilities", () => {
  const record = toVulnRecord(raw(), wanted) as VulnRecord;
  const core: VulnRecord = {
    ...record,
    id: "ffff0000-1111-2222-3333-444455556666",
    title: "WordPress Core < 6.4.3 - Object Injection",
    severity: "high",
    software: [
      {
        type: "core",
        slug: "wordpress",
        ranges: [{ from: "6.4", fromInclusive: true, to: "6.4.3", toInclusive: false }],
        patchedVersions: ["6.4.3"],
      },
    ],
  };

  it("matches affected versions and picks the lowest fix above the installed one", () => {
    const matches = matchVulnerabilities(
      [
        { type: "plugin", slug: "Contact-Form", version: "5.0" },
        { type: "core", slug: "wordpress", version: "6.4.2" },
      ],
      [record, core],
    );
    expect(matches).toEqual([
      {
        vulnerabilityId: record.id,
        type: "plugin",
        slug: "contact-form",
        installedVersion: "5.0",
        fixedIn: "5.2",
      },
      {
        vulnerabilityId: core.id,
        type: "core",
        slug: "wordpress",
        installedVersion: "6.4.2",
        fixedIn: "6.4.3",
      },
    ]);
  });

  it("ignores patched versions, other types with the same slug, and empty versions", () => {
    expect(
      matchVulnerabilities(
        [
          { type: "plugin", slug: "contact-form", version: "5.2" },
          { type: "theme", slug: "contact-form", version: "1.0" },
          { type: "core", slug: "wordpress", version: "" },
        ],
        [record, core],
      ),
    ).toEqual([]);
  });

  it("returns null fixedIn when no newer patched version exists", () => {
    const [software] = record.software;
    if (!software) throw new Error("fixture has no software");
    const unfixed: VulnRecord = { ...record, software: [{ ...software, patchedVersions: [] }] };
    expect(
      matchVulnerabilities([{ type: "plugin", slug: "contact-form", version: "1.0" }], [unfixed])[0]
        ?.fixedIn,
    ).toBeNull();
  });
});

describe("worstSeverity", () => {
  it("picks the worst level", () => {
    expect(worstSeverity(["low", "high", "medium"])).toBe("high");
    expect(worstSeverity(["unknown"])).toBe("unknown");
    expect(worstSeverity([])).toBeNull();
  });
});

describe("VulnFeedResult", () => {
  it("accepts a failure without records", () => {
    expect(
      VulnFeedResult.safeParse({ ok: false, reason: "not_configured", detail: "x" }).success,
    ).toBe(true);
  });
});
