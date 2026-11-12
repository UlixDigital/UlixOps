"use client";
// Add or edit one DNS record (A156). Names can be "@", "www" or a full name in the domain.
import {
  type DnsRecord,
  MANAGED_RECORD_TYPES,
  PROXIABLE_TYPES,
  shortRecordName,
} from "@ulixops/shared";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { saveRecordAction } from "../actions";

const TTLS = [
  { value: "1", label: "Auto" },
  { value: "300", label: "5 minutes" },
  { value: "3600", label: "1 hour" },
  { value: "14400", label: "4 hours" },
  { value: "86400", label: "1 day" },
];

/** Not login fields: keep 1Password, LastPass and Bitwarden icons out of them. */
const NO_PASSWORD_MANAGER = {
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": true,
  "data-form-type": "other",
} as const;

const HINTS: Record<string, string> = {
  A: "IPv4 address, e.g. 141.193.213.10 (WP Engine)",
  AAAA: "IPv6 address",
  CNAME: "Host name, e.g. wp.wpenginepowered.com",
  TXT: "Text on one line, e.g. v=spf1 include:_spf.google.com ~all",
  MX: "Mail server host name, e.g. aspmx.l.google.com",
};

export function RecordForm({
  zoneId,
  zone,
  record,
}: {
  zoneId: string;
  zone: string;
  record?: DnsRecord;
}) {
  const [type, setType] = useState(record?.type ?? "A");
  const id = record?.id ?? "new";
  const ttl = record ? String(record.ttl) : "1";
  return (
    <ActionForm
      action={saveRecordAction}
      submitLabel={record ? "Save record" : "Add record"}
      pendingLabel="Saving to Cloudflare…"
      confirm={
        record
          ? {
              title: `Change ${record.type} ${record.name}?`,
              description:
                "The new value goes live in Cloudflare at once. A snapshot of the domain is taken first, so it can be rolled back.",
            }
          : undefined
      }
    >
      <input type="hidden" name="zoneId" value={zoneId} />
      {record && <input type="hidden" name="recordId" value={record.id} />}
      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <div className="grid gap-1.5">
          <Label htmlFor={`type-${id}`}>Type</Label>
          <Select
            id={`type-${id}`}
            name="type"
            value={type}
            disabled={Boolean(record)}
            onChange={(e) => setType(e.target.value)}
          >
            {MANAGED_RECORD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          {record && <input type="hidden" name="type" value={record.type} />}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`name-${id}`}>Name</Label>
          <Input
            id={`name-${id}`}
            name="name"
            defaultValue={record ? shortRecordName(record.name, zone) : ""}
            placeholder="@ for the domain itself, or www"
            autoComplete="off"
            spellCheck={false}
            {...NO_PASSWORD_MANAGER}
            required
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`content-${id}`}>{type === "TXT" ? "Text" : "Points to"}</Label>
        <Input
          id={`content-${id}`}
          name="content"
          defaultValue={record?.content ?? ""}
          placeholder={HINTS[type]}
          autoComplete="off"
          spellCheck={false}
          {...NO_PASSWORD_MANAGER}
          required
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`ttl-${id}`}>TTL</Label>
          <Select
            id={`ttl-${id}`}
            name="ttl"
            defaultValue={TTLS.some((t) => t.value === ttl) ? ttl : "1"}
          >
            {TTLS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
        {type === "MX" && (
          <div className="grid gap-1.5">
            <Label htmlFor={`priority-${id}`}>Priority</Label>
            <Input
              id={`priority-${id}`}
              name="priority"
              type="number"
              min={0}
              max={65535}
              defaultValue={record?.priority ?? 10}
              required
            />
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor={`comment-${id}`}>Note (optional)</Label>
          <Input
            id={`comment-${id}`}
            name="comment"
            defaultValue={record?.comment ?? ""}
            maxLength={100}
            autoComplete="off"
            {...NO_PASSWORD_MANAGER}
          />
        </div>
      </div>
      {PROXIABLE_TYPES.includes(type) && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="proxied"
            defaultChecked={record ? record.proxied : true}
            className="mt-1 size-4 rounded border border-input"
          />
          <span>
            Proxied through Cloudflare (orange cloud). Turn off for mail servers and anything that
            must reach the server directly.
          </span>
        </label>
      )}
    </ActionForm>
  );
}
