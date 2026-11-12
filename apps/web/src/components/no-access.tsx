import type { RoleName } from "@ulixops/shared";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const ROLE_LABELS: Record<RoleName, string> = {
  CLIENT_VIEWER: "Client Viewer",
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Admin",
  DEVELOPER: "Developer",
  VIEWER: "Viewer",
};

export function NoAccess({ role, what }: { role: RoleName; what: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">No access</CardTitle>
        <CardDescription>
          Your role ({ROLE_LABELS[role]}) can't open {what}. Ask an Admin if you need it.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
