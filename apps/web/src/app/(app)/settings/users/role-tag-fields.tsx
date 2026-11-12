"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RoleOptions, Select } from "@/components/ui/select";

/** Role picker that reveals the required site tag when Client Viewer is chosen (A178). */
export function RoleTagFields({
  idPrefix,
  defaultRole,
  defaultViewTag,
  includeSuperAdmin = false,
}: {
  idPrefix: string;
  defaultRole: string;
  defaultViewTag?: string | null;
  includeSuperAdmin?: boolean;
}) {
  const [role, setRole] = useState(defaultRole);
  const needsTag = role === "CLIENT_VIEWER";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-role`}>Role</Label>
        <Select
          id={`${idPrefix}-role`}
          name="role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <RoleOptions includeSuperAdmin={includeSuperAdmin} />
        </Select>
      </div>
      {needsTag && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-viewTag`}>Site tag</Label>
          <Input
            id={`${idPrefix}-viewTag`}
            name="viewTag"
            required
            defaultValue={defaultViewTag ?? ""}
            maxLength={40}
            placeholder="e.g. acme"
            pattern="[a-z0-9][a-z0-9 _-]{0,39}"
            title="Lowercase letters, numbers, spaces, _ or -"
          />
          <p className="text-xs text-muted-foreground">
            They only see sites that include this exact tag.
          </p>
        </div>
      )}
    </div>
  );
}
