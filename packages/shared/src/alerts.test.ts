import { describe, expect, it } from "vitest";
import {
  alertTransition,
  isActionableKind,
  isAutoVerifiedKind,
  ResolveAlertRequest,
  RECOVERY_ALERT_KINDS,
} from "./alerts";

describe("alert state machine", () => {
  it("walks open → in progress → fixed → confirmed", () => {
    expect(alertTransition("OPEN", "acknowledge")).toBe("ACKNOWLEDGED");
    expect(alertTransition("ACKNOWLEDGED", "acknowledge")).toBe("ACKNOWLEDGED");
    expect(alertTransition("ACKNOWLEDGED", "resolve")).toBe("RESOLVED");
    expect(alertTransition("RESOLVED", "confirm")).toBe("VERIFIED");
  });

  it("sends a rejected or recurring fix back to open", () => {
    expect(alertTransition("RESOLVED", "reject")).toBe("OPEN");
    expect(alertTransition("RESOLVED", "recur")).toBe("OPEN");
    expect(alertTransition("ACKNOWLEDGED", "recur")).toBe("ACKNOWLEDGED");
  });

  it("credits a clean check to a reported fix, otherwise clears without credit", () => {
    expect(alertTransition("RESOLVED", "clear")).toBe("VERIFIED");
    expect(alertTransition("OPEN", "clear")).toBe("AUTO_CLEARED");
    expect(alertTransition("ACKNOWLEDGED", "clear")).toBe("AUTO_CLEARED");
  });

  it("refuses steps that skip the process", () => {
    expect(alertTransition("OPEN", "confirm")).toBeNull();
    expect(alertTransition("VERIFIED", "resolve")).toBeNull();
    expect(alertTransition("RESOLVED", "resolve")).toBeNull();
    expect(alertTransition("OPEN", "reopen")).toBeNull();
    expect(alertTransition("VERIFIED", "reopen")).toBe("OPEN");
    for (const action of ["acknowledge", "resolve", "confirm", "clear", "reopen"] as const)
      expect(alertTransition("INFO", action)).toBeNull();
  });
});

describe("alert kinds", () => {
  it("treats success events and awareness-only kinds as info only", () => {
    expect(isActionableKind("uptime.up")).toBe(false);
    expect(isActionableKind("deployment.succeeded")).toBe(false);
    expect(isActionableKind("security.NEW_DEVICE_LOGIN")).toBe(false);
    expect(isActionableKind("report.ready")).toBe(false);
    expect(isActionableKind("approval.self_approved")).toBe(false);
    expect(isActionableKind("security.ACCOUNT_LOCKED")).toBe(true);
    expect(isActionableKind("malware.found")).toBe(true);
  });

  it("only auto-verifies kinds the hub re-checks", () => {
    expect(isAutoVerifiedKind("malware.found")).toBe(true);
    expect(isAutoVerifiedKind("deployment.failed")).toBe(false);
    expect(RECOVERY_ALERT_KINDS["uptime.up"]).toEqual(["uptime.down"]);
  });

  it("requires a real note when reporting a fix", () => {
    const base = { resolution: "FIXED", fixAction: "removed_malware" } as const;
    expect(ResolveAlertRequest.safeParse({ ...base, note: "done" }).success).toBe(false);
    expect(ResolveAlertRequest.safeParse({ ...base, note: "Deleted shadow.php" }).success).toBe(
      true,
    );
    expect(
      ResolveAlertRequest.safeParse({
        ...base,
        fixAction: "approval_decided",
        note: "x".repeat(20),
      }).success,
    ).toBe(false);
  });
});
