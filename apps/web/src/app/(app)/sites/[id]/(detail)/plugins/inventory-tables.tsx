"use client";
// Installed plugins and themes from the last inventory (spec screen 5, Plugins & themes).
import { type EnvKind, type InventoryItem, PluginName, ThemeName } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { ActionForm } from "@/components/action-form";
import { DataTable } from "@/components/data-table";
import { siteActionAction, updatePluginAction, updateThemeAction } from "../../../actions";
import { Badge } from "../parts";

const STATUS: Record<InventoryItem["status"], { label: string; tone: "success" | "muted" }> = {
  active: { label: "Active", tone: "success" },
  "active-network": { label: "Network active", tone: "success" },
  parent: { label: "Parent theme", tone: "success" },
  inactive: { label: "Inactive", tone: "muted" },
  "must-use": { label: "Must-use", tone: "muted" },
  dropin: { label: "Drop-in", tone: "muted" },
};

const baseColumns = <T extends InventoryItem>(): ColumnDef<T>[] => [
  {
    id: "name",
    header: "Name",
    accessorFn: (i) => `${i.title} ${i.name}`,
    cell: ({ row }) => (
      <span className="grid">
        <span className="font-medium">{row.original.title || row.original.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{row.original.name}</span>
      </span>
    ),
  },
  {
    id: "status",
    header: "Status",
    accessorFn: (i) => STATUS[i.status].label,
    cell: ({ row }) => (
      <Badge tone={STATUS[row.original.status].tone}>{STATUS[row.original.status].label}</Badge>
    ),
  },
  { id: "version", header: "Version", accessorFn: (i) => i.version || "—" },
  {
    id: "update",
    header: "Update",
    accessorFn: (i) => i.updateVersion ?? "",
    cell: ({ row }) =>
      row.original.updateVersion ? (
        <Badge tone="warning">{row.original.updateVersion} available</Badge>
      ) : (
        <span className="text-muted-foreground">Up to date</span>
      ),
  },
];

export function PluginsTable({
  siteId,
  kind,
  plugins,
  canActivate,
  canDeactivate,
  canUpdate,
}: {
  siteId: string;
  kind: EnvKind;
  plugins: InventoryItem[];
  canActivate: boolean;
  canDeactivate: boolean;
  canUpdate: boolean;
}) {
  const where = kind === "PRODUCTION" ? "production" : "staging";
  const columns = useMemo<ColumnDef<InventoryItem>[]>(
    () => [
      ...baseColumns<InventoryItem>(),
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const p = row.original;
          if (!PluginName.safeParse(p.name).success || !["active", "inactive"].includes(p.status))
            return null;
          const activate = p.status === "inactive";
          const showToggle = activate ? canActivate : canDeactivate;
          const showUpdate = canUpdate && Boolean(p.updateVersion);
          if (!showToggle && !showUpdate) return null;
          return (
            <div className="flex flex-wrap items-center gap-2">
              {showUpdate && (
                <ActionForm
                  action={updatePluginAction}
                  submitLabel="Update"
                  confirm={{
                    title: `Update ${p.title || p.name} on ${where}?`,
                    description: `UlixOps will take a quick snapshot of the plugin folder first${p.updateVersion && p.version.split(".")[0] !== p.updateVersion.split(".")[0] ? " (and the database, because this looks like a major version bump)" : ""}, then run the update. Use Emergency → Restore latest snapshot if something breaks.`,
                  }}
                >
                  <input type="hidden" name="siteId" value={siteId} />
                  <input type="hidden" name="kind" value={kind} />
                  <input type="hidden" name="plugin" value={p.name} />
                </ActionForm>
              )}
              {showToggle && (
                <ActionForm
                  action={siteActionAction}
                  submitLabel={activate ? "Activate" : "Deactivate"}
                  variant={activate ? "outline" : "destructive"}
                  confirm={{
                    title: `${activate ? "Activate" : "Deactivate"} ${p.title || p.name} on ${where}?`,
                    description: activate
                      ? "WordPress runs the plugin's activation code on the live site straight away. Use Emergency → Deactivate if it breaks the site."
                      : "The site stops running this plugin straight away, and the plugin's deactivation code runs. Its settings stay in the database.",
                  }}
                >
                  <input type="hidden" name="siteId" value={siteId} />
                  <input type="hidden" name="kind" value={kind} />
                  <input
                    type="hidden"
                    name="action"
                    value={activate ? "plugin.activate" : "plugin.deactivate"}
                  />
                  <input type="hidden" name="plugin" value={p.name} />
                </ActionForm>
              )}
            </div>
          );
        },
      },
    ],
    [siteId, kind, where, canActivate, canDeactivate, canUpdate],
  );
  return (
    <DataTable
      columns={columns}
      data={plugins}
      searchLabel="Search plugins"
      emptyText="No plugins match."
      initialSorting={[{ id: "name", desc: false }]}
    />
  );
}

export function ThemesTable({
  siteId,
  kind,
  themes,
  canUpdate,
}: {
  siteId: string;
  kind: EnvKind;
  themes: InventoryItem[];
  canUpdate: boolean;
}) {
  const where = kind === "PRODUCTION" ? "production" : "staging";
  const columns = useMemo<ColumnDef<InventoryItem>[]>(
    () => [
      ...baseColumns<InventoryItem>(),
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const t = row.original;
          if (!ThemeName.safeParse(t.name).success || !t.updateVersion || !canUpdate) return null;
          return (
            <ActionForm
              action={updateThemeAction}
              submitLabel="Update"
              confirm={{
                title: `Update theme ${t.title || t.name} on ${where}?`,
                description: `UlixOps will take a quick snapshot of the theme folder first${t.version.split(".")[0] !== t.updateVersion.split(".")[0] ? " (and the database, because this looks like a major version bump)" : ""}, then run the update.`,
              }}
            >
              <input type="hidden" name="siteId" value={siteId} />
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="theme" value={t.name} />
            </ActionForm>
          );
        },
      },
    ],
    [siteId, kind, where, canUpdate],
  );
  return (
    <DataTable
      columns={columns}
      data={themes}
      searchLabel="Search themes"
      emptyText="No themes match."
      initialSorting={[{ id: "status", desc: false }]}
    />
  );
}
