// Reports API (P4-4, A165).
import {
  EmailReportRequest,
  GenerateReportRequest,
  RecordId,
  ReportsOverview,
  SiteReportView,
} from "@ulixops/shared";
import { Router } from "express";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import {
  emailReport,
  generateReport,
  getReport,
  reportPdfBuffer,
  reportsOverview,
  type ReportDeps,
} from "./service";

export function reportsRouter(deps: ReportDeps): Router {
  const router = Router();
  const canView = authorize("dashboard.view", deps);
  const canManage = authorize("settings.manage", deps);

  router.get("/overview", canView, async (req, res) => {
    const body: ReportsOverview = await reportsOverview(deps, sessionOf(req).user);
    res.json(ReportsOverview.parse(body));
  });

  router.post("/generate", canManage, async (req, res) => {
    const parsed = GenerateReportRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const view = await generateReport(deps, parsed.data, {
      userId: sessionOf(req).user.id,
      ip: clientIpOf(req),
    });
    res.status(201).json(SiteReportView.parse(view));
  });

  router.get("/:id", canView, async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const view = await getReport(deps, id.data, sessionOf(req).user);
    if (!view) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(SiteReportView.parse(view));
  });

  router.get("/:id/pdf", canView, async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const pdf = await reportPdfBuffer(deps, id.data, sessionOf(req).user);
    if (!pdf) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${pdf.filename}"`);
    res.send(pdf.buffer);
  });

  router.post("/:id/email", canManage, async (req, res) => {
    const id = RecordId.safeParse(req.params.id);
    const body = EmailReportRequest.safeParse(req.body ?? {});
    if (!id.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const result = await emailReport(deps, id.data, body.data.to, {
      userId: sessionOf(req).user.id,
      ip: clientIpOf(req),
    });
    if (!result.ok) {
      const status =
        result.error === "smtp_not_configured" ? 503 : result.error === "not_ready" ? 404 : 502;
      res.status(status).json({ error: result.error });
      return;
    }
    res.json({ ok: true, to: result.to });
  });

  return router;
}
