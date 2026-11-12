import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inviteUserAction } from "../actions";
import { RoleTagFields } from "./role-tag-fields";
import { UsersPageClient } from "./users-page-client";

export const metadata: Metadata = { title: "Users & roles · UlixOps" };
export const dynamic = "force-dynamic";

export default function UsersPage() {
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invite someone</CardTitle>
          <CardDescription>
            UlixOps creates a one-time setup link (24 hours). Send it to them privately; they choose
            a password and set up 2FA. UlixOps doesn't email the link itself.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm
            action={inviteUserAction}
            submitLabel="Create invite"
            linkNote="Setup link: send it to them privately. It works once, for 24 hours."
          >
            <div className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="invite-email">Email</Label>
                  <Input id="invite-email" name="email" type="email" required />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="invite-name">Name (optional)</Label>
                  <Input id="invite-name" name="name" maxLength={100} />
                </div>
              </div>
              <RoleTagFields idPrefix="invite" defaultRole="VIEWER" />
            </div>
          </ActionForm>
        </CardContent>
      </Card>

      <UsersPageClient />
    </div>
  );
}
