// Per-site monthly report PDF (A165). Same structure as the hub report page.
import PDFDocument from "pdfkit";
import type { ReportIssue, ReportSummary } from "@ulixops/shared";

const PAGE_BOTTOM = 780;
const MARGIN = 40;

function formatUtc(iso: string | null): string {
  if (!iso) return "—";
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function severityLabel(s: ReportIssue["severity"]): string {
  if (s === "critical") return "Critical";
  if (s === "warning") return "Warning";
  return "Info";
}

function statusLabel(s: ReportIssue["status"]): string {
  if (s === "open") return "Open";
  if (s === "fixed") return "Fixed";
  return "Cleared";
}

function severityColor(s: ReportIssue["severity"]): string {
  if (s === "critical") return "#b42318";
  if (s === "warning") return "#9a6700";
  return "#555555";
}

function statusColor(s: ReportIssue["status"]): string {
  if (s === "open") return "#b42318";
  if (s === "fixed") return "#1f7a4d";
  return "#555555";
}

type PdfDoc = InstanceType<typeof PDFDocument>;

function ensureSpace(doc: PdfDoc, need: number): void {
  if (doc.y + need > PAGE_BOTTOM) {
    doc.addPage();
    doc.x = doc.page.margins.left;
  }
}

function sectionLabel(doc: PdfDoc, text: string): void {
  doc.x = doc.page.margins.left;
  doc.fontSize(8).fillColor("#666").text(text.toUpperCase());
  doc.moveDown(0.35);
}

export async function buildReportPdf(
  summary: ReportSummary,
  opts?: { generatedAt?: string },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: MARGIN,
      info: { Title: `UlixOps report — ${summary.siteName} — ${summary.label}` },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Header — matches hub: site name + month, URL, generated
    doc.fontSize(18).fillColor("#111").text(`${summary.siteName} `, { continued: true });
    doc.fontSize(14).fillColor("#666").text(summary.label);
    doc.fontSize(9).fillColor("#555").text(summary.siteUrl);
    const meta = [
      opts?.generatedAt ? `Generated ${formatUtc(opts.generatedAt)}` : null,
      `${summary.label} (UTC)`,
    ]
      .filter(Boolean)
      .join("  ·  ");
    if (meta) doc.text(meta);
    doc.moveDown(0.9);

    // At a glance
    sectionLabel(doc, "At a glance");
    const g = summary.glance;
    const cards = [
      { label: "Issues raised", value: String(g.raised) },
      { label: "Still open", value: String(g.open) },
      { label: "Fixed / cleared", value: String(g.fixed + g.cleared) },
      { label: "Median time to fix", value: g.medianFixLabel ?? "—" },
    ];
    const gap = 8;
    const cardW = (width - gap * 3) / 4;
    const cardY = doc.y;
    const cardH = 48;
    cards.forEach((card, i) => {
      const x = left + i * (cardW + gap);
      doc.roundedRect(x, cardY, cardW, cardH, 4).stroke("#e4e4df");
      doc
        .fontSize(8)
        .fillColor("#666")
        .text(card.label, x + 8, cardY + 8, {
          width: cardW - 16,
        });
      doc
        .fontSize(16)
        .fillColor("#111")
        .text(card.value, x + 8, cardY + 22, {
          width: cardW - 16,
        });
    });
    doc.x = left;
    doc.y = cardY + cardH + 14;

    // Severity + Ops (two cards)
    const colGap = 10;
    const colW = (width - colGap) / 2;
    const rowY = doc.y;
    const boxPad = 10;
    const boxH = 120;

    doc.roundedRect(left, rowY, colW, boxH, 4).stroke("#e4e4df");
    doc
      .fontSize(10)
      .fillColor("#111")
      .text("Severity this month", left + boxPad, rowY + boxPad);
    const sev = summary.severity;
    const sevMax = Math.max(1, sev.critical, sev.warning, sev.info);
    const bars: { label: string; n: number; color: string }[] = [
      { label: "Critical", n: sev.critical, color: "#b42318" },
      { label: "Warning", n: sev.warning, color: "#d97706" },
      { label: "Info", n: sev.info, color: "#2563eb" },
    ];
    let by = rowY + boxPad + 18;
    for (const b of bars) {
      doc
        .fontSize(8)
        .fillColor("#333")
        .text(b.label, left + boxPad, by, {
          width: colW - boxPad * 2 - 24,
          continued: false,
        });
      doc
        .fontSize(8)
        .fillColor("#333")
        .text(String(b.n), left + colW - boxPad - 20, by, {
          width: 20,
          align: "right",
        });
      by += 11;
      const trackW = colW - boxPad * 2;
      const barW = (trackW * b.n) / sevMax;
      doc.roundedRect(left + boxPad, by, trackW, 6, 3).fill("#f0f0ec");
      if (barW > 0) doc.roundedRect(left + boxPad, by, Math.max(barW, 4), 6, 3).fill(b.color);
      by += 14;
    }

    const ox = left + colW + colGap;
    doc.roundedRect(ox, rowY, colW, boxH, 4).stroke("#e4e4df");
    doc
      .fontSize(10)
      .fillColor("#111")
      .text("Ops snapshot (production)", ox + boxPad, rowY + boxPad);
    const o = summary.ops;
    const up = o.uptimePercent == null ? "n/a" : `${o.uptimePercent}%`;
    const opsLines = [
      `Uptime ${up} · ${o.incidents} incident${o.incidents === 1 ? "" : "s"} (${o.downtimeMinutes} min)`,
      `Malware scans: ${o.malwareScans}` +
        (o.malwareInfected ? ` · ${o.malwareInfected} infected` : " · clean"),
      `Vulns: ${o.vulnsOpen} open · ${o.vulnsNew} new · ${o.vulnsResolved} resolved`,
      `Integrity ${o.integrityChanged} · PHP fatals ${o.phpFatals} · Visual ${o.visualChanged}/${o.visualFailed}`,
    ];
    let oy = rowY + boxPad + 20;
    for (const line of opsLines) {
      doc
        .fontSize(8)
        .fillColor("#555")
        .text(`•  ${line}`, ox + boxPad, oy, {
          width: colW - boxPad * 2,
        });
      oy += 16;
    }

    doc.x = left;
    doc.y = rowY + boxH + 16;

    // Issues table — same columns as the hub UI
    sectionLabel(doc, "Issues, actions & time to fix");
    if (summary.issues.length === 0) {
      doc.fontSize(9).fillColor("#666").text("No actionable issues in this period.");
      doc.moveDown();
    } else {
      drawIssuesTable(doc, summary.issues, left, width);
    }

    // Full details
    ensureSpace(doc, 90);
    doc.x = left;
    sectionLabel(doc, "Full details (production)");
    doc.fontSize(9).fillColor("#333");
    const detailLines = [
      ["Malware scans", `${o.malwareScans} finished · ${o.malwareInfected} infected.`],
      [
        "Vulnerabilities",
        `${o.vulnsNew} new, ${o.vulnsResolved} resolved, ${o.vulnsOpen} open now.`,
      ],
      [
        "File integrity",
        `${o.integrityChanged} changed check${o.integrityChanged === 1 ? "" : "s"}.`,
      ],
      [
        "SSL & domains",
        `SSL expires ${o.sslExpiresAt ? o.sslExpiresAt.slice(0, 10) : "—"} · Domain expires ${o.domainExpiresAt ? o.domainExpiresAt.slice(0, 10) : "—"}.`,
      ],
      ["PHP errors", `${o.phpFatals} fatal alert${o.phpFatals === 1 ? "" : "s"} this month.`],
      [
        "Uptime",
        `${up} · ${o.incidents} incident${o.incidents === 1 ? "" : "s"} · ${o.downtimeMinutes} min downtime.`,
      ],
      ["Visual checks", `${o.visualChanged} changed · ${o.visualFailed} failed.`],
    ] as const;
    for (const [label, body] of detailLines) {
      doc.font("Helvetica-Bold").fillColor("#111").text(`${label} — `, { continued: true });
      doc.font("Helvetica").fillColor("#555").text(body);
      doc.moveDown(0.25);
    }

    doc.moveDown(0.8);
    doc
      .fontSize(7)
      .fillColor("#888")
      .text(
        "Generated by UlixOps. Issue times come from hub alert follow-up; ops figures are from hub records for this period.",
      );

    doc.end();
  });
}

function drawIssuesTable(doc: PdfDoc, issues: ReportIssue[], left: number, width: number): void {
  // Column fractions match the hub table: Issue | Severity | Action | Raised→fixed | Status
  const cols = [
    { key: "issue", label: "Issue", w: width * 0.32 },
    { key: "severity", label: "Severity", w: width * 0.1 },
    { key: "action", label: "Action", w: width * 0.22 },
    { key: "when", label: "Raised -> fixed", w: width * 0.26 },
    { key: "status", label: "Status", w: width * 0.1 },
  ] as const;

  const drawHeader = () => {
    const y = doc.y;
    doc.rect(left, y, width, 18).fill("#f4f4f0");
    let x = left;
    for (const c of cols) {
      doc
        .fontSize(7)
        .fillColor("#666")
        .text(c.label, x + 4, y + 5, { width: c.w - 8, lineBreak: false });
      x += c.w;
    }
    doc.y = y + 20;
    doc.x = left;
  };

  drawHeader();

  for (const issue of issues) {
    const action = issue.action ?? "—";
    const whenLines = [
      formatUtc(issue.raisedAt),
      `-> ${issue.fixedAt ? formatUtc(issue.fixedAt) : "open"}`,
      issue.durationLabel,
    ];
    doc.fontSize(8);
    const titleH = doc.heightOfString(issue.title, { width: cols[0].w - 8 });
    const actionH = doc.heightOfString(action, { width: cols[2].w - 8 });
    const rowH = Math.max(28, titleH, 10, actionH, whenLines.length * 10) + 10;

    if (doc.y + rowH > PAGE_BOTTOM) {
      doc.addPage();
      doc.x = left;
      drawHeader();
    }

    const y = doc.y;
    doc
      .moveTo(left, y + rowH)
      .lineTo(left + width, y + rowH)
      .strokeColor("#eaeae6")
      .lineWidth(0.5)
      .stroke();

    let x = left;
    doc
      .fontSize(8)
      .fillColor("#111")
      .text(issue.title, x + 4, y + 4, { width: cols[0].w - 8 });
    x += cols[0].w;

    doc
      .fontSize(8)
      .fillColor(severityColor(issue.severity))
      .text(severityLabel(issue.severity), x + 4, y + 4, {
        width: cols[1].w - 8,
      });
    x += cols[1].w;

    doc
      .fontSize(8)
      .fillColor("#555")
      .text(action, x + 4, y + 4, { width: cols[2].w - 8 });
    x += cols[2].w;

    let wy = y + 4;
    for (const line of whenLines) {
      doc
        .fontSize(7)
        .fillColor("#555")
        .text(line, x + 4, wy, { width: cols[3].w - 8, lineBreak: false });
      wy += 10;
    }
    x += cols[3].w;

    doc
      .fontSize(8)
      .fillColor(statusColor(issue.status))
      .text(statusLabel(issue.status), x + 4, y + 4, {
        width: cols[4].w - 8,
      });

    doc.y = y + rowH;
    doc.x = left;
  }
  doc.moveDown(0.6);
}
