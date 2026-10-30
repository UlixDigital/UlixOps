import { describe, expect, it } from "vitest";
import {
  installFromWpEngineUrl,
  productionInstallFromStaging,
  resolveWpEngineEnv,
  wpEngineSshFields,
} from "./wpengine";

describe("installFromWpEngineUrl", () => {
  it("reads the subdomain from wpengine hosts", () => {
    expect(installFromWpEngineUrl("https://foostg.wpengine.com")).toBe("foostg");
    expect(installFromWpEngineUrl("https://Shop.wpenginepowered.com/path")).toBe("shop");
  });

  it("returns null for custom domains", () => {
    expect(installFromWpEngineUrl("https://www.example.com")).toBeNull();
  });
});

describe("productionInstallFromStaging", () => {
  it("strips common staging suffixes", () => {
    expect(productionInstallFromStaging("foostg")).toBe("foo");
    expect(productionInstallFromStaging("acme-stg")).toBe("acme");
    expect(productionInstallFromStaging("acmestaging")).toBe("acme");
  });

  it("returns null when there is no suffix", () => {
    expect(productionInstallFromStaging("acme")).toBeNull();
  });
});

describe("wpEngineSshFields", () => {
  it("uses Gateway host, user and path candidates", () => {
    expect(wpEngineSshFields("clientsite")).toEqual({
      sshHost: "clientsite.ssh.wpengine.net",
      sshUser: "clientsite",
      sshPort: 22,
      wpPath: "/sites/clientsite",
      wpPathCandidates: ["/sites/clientsite", "/home/wpe-user/sites/clientsite"],
    });
  });
});

describe("resolveWpEngineEnv", () => {
  it("fills production from a wpengine URL", () => {
    const result = resolveWpEngineEnv({
      url: "https://shop.wpengine.com",
      credentialRef: "SHOP_SSH_KEY",
      role: "production",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      install: "shop",
      sshHost: "shop.ssh.wpengine.net",
      sshUser: "shop",
      wpPath: "/sites/shop",
      credentialRef: "SHOP_SSH_KEY",
    });
  });

  it("derives production install from a staging peer on a custom prod URL", () => {
    const result = resolveWpEngineEnv({
      url: "https://www.client.com",
      credentialRef: "CLIENT_SSH_KEY",
      role: "production",
      peerInstall: "clientstg",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.install).toBe("client");
    expect(result.data.sshHost).toBe("client.ssh.wpengine.net");
  });

  it("asks for an install hint when the URL and peer are not enough", () => {
    const result = resolveWpEngineEnv({
      url: "https://www.client.com",
      credentialRef: "CLIENT_SSH_KEY",
      role: "production",
    });
    expect(result).toMatchObject({ ok: false, needInstallHint: true });
  });

  it("uses an install hint for a custom domain", () => {
    const result = resolveWpEngineEnv({
      url: "https://www.client.com",
      credentialRef: "CLIENT_SSH_KEY",
      role: "production",
      installHint: "client",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.install).toBe("client");
  });
});
