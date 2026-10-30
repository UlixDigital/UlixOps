import { describe, expect, it } from "vitest";
import { CreateDeploymentRequest, deploymentNeedsApproval } from "./deployments";

describe("deploymentNeedsApproval", () => {
  it("requires a second Admin for two or more production sites", () => {
    expect(deploymentNeedsApproval(1)).toBe(false);
    expect(deploymentNeedsApproval(2)).toBe(true);
    expect(deploymentNeedsApproval(27)).toBe(true);
  });
});

describe("CreateDeploymentRequest", () => {
  it("defaults staging-first, batch size 2 and pause-on-failure", () => {
    const parsed = CreateDeploymentRequest.parse({
      pluginSlug: "ulix-forms",
      version: "1.2.0",
      siteIds: ["c".repeat(25)],
    });
    expect(parsed).toMatchObject({
      stagingFirst: true,
      batchSize: 2,
      pauseOnFailure: true,
    });
  });
});
