"use client";

import { UserList, type UserSummary } from "@ulixops/shared";
import { useCallback, useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { UsersTable } from "./users-table";

export function UsersPageClient() {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch(`/api/users/list?_=${Date.now()}`, {
        cache: "no-store",
        headers: { "cache-control": "no-store", pragma: "no-cache" },
      });
      if (!res.ok) {
        setError(true);
        setUsers(null);
        return;
      }
      const parsed = UserList.safeParse(await res.json());
      if (!parsed.success) {
        setError(true);
        setUsers(null);
        return;
      }
      setUsers(parsed.data.users);
    } catch {
      setError(true);
      setUsers(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">People{users ? ` (${users.length})` : ""}</h2>
        <button
          type="button"
          className={buttonVariants({ variant: "outline", size: "sm" })}
          onClick={() => void load()}
        >
          Refresh list
        </button>
      </div>
      {error && (
        <Notice tone="error">
          People couldn&apos;t be loaded.{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            Try again
          </button>
          .
        </Notice>
      )}
      {users === null && !error ? (
        <p className="text-sm text-muted-foreground">Loading people…</p>
      ) : users ? (
        <UsersTable users={users} />
      ) : null}
    </section>
  );
}
