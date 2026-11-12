import { can, isClientViewer, NotificationList } from "@ulixops/shared";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { CommandPalette } from "@/components/shell/command-palette";
import { NotificationBell } from "@/components/shell/notification-bell";
import { Sidebar } from "@/components/shell/sidebar";
import { MobileNav, SearchButton, ThemeToggle, UserMenu } from "@/components/shell/top-bar";
import { Toaster } from "@/components/toaster";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { readFlash } from "@/lib/flash";
import { ROLE_LABELS } from "@/lib/format";
import { navFor, paletteLinksFor } from "@/lib/nav";
import { parseTheme, SIDEBAR_COOKIE, THEME_COOKIE } from "@/lib/ui-prefs";
import { logoutAction } from "../(auth)/actions";

// App shell (spec 3a): collapsible sidebar, top bar with Cmd+K search and the user menu.
export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { user } = await requireSession();
  const jar = await cookies();
  const { main, later } = navFor(user.role);
  // Unread alerts for the bell and its popups (A158); Client Viewer has no inbox (A178).
  const showBell = can(user.role, "notifications.view") && !isClientViewer(user.role);
  const bell = showBell
    ? await apiGet("/notifications?limit=8&unread=1", NotificationList, await apiAuth())
    : null;
  const paletteLinks = [
    ...main
      .filter((item) => !item.soon)
      .map((item) => ({ href: item.href, label: item.label, group: "Go to" })),
    ...paletteLinksFor(user.role),
  ];

  return (
    <div className="flex min-h-dvh">
      <Sidebar
        main={main}
        later={later}
        initiallyCollapsed={jar.get(SIDEBAR_COOKIE)?.value === "collapsed"}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background px-4 md:px-6">
          <MobileNav main={main} later={later} />
          <div className="flex flex-1">
            <SearchButton />
          </div>
          {bell && <NotificationBell initial={bell.ok ? bell.data : null} />}
          <ThemeToggle initial={parseTheme(jar.get(THEME_COOKIE)?.value)} />
          <UserMenu
            email={user.email}
            name={user.name}
            roleLabel={ROLE_LABELS[user.role]}
            signOut={logoutAction}
          />
        </header>
        <main className="mx-auto w-full max-w-6xl min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>
      <CommandPalette links={paletteLinks} signOut={logoutAction} />
      <Toaster message={await readFlash()} />
    </div>
  );
}
