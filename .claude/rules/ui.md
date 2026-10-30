# UI rules (spec section 3a, details in docs/UI.md)

1. Neutral greys (zinc) with ONE accent: Ulix blue `--primary` (#2563EB, hover #1E40AF, dark-mode sidebar #0B2A6F). Colour otherwise only for status: muted green success, amber warning, red error.
2. Use design tokens from `apps/web/src/app/globals.css` (`bg-background`, `text-muted-foreground`, `bg-primary`...). No raw hex values in components.
3. No gradients, heavy shadows or decorative illustrations. Animations are subtle fades/transitions under 200 ms.
4. Components: shadcn/ui (`components.json` is set up), lucide-react icons, Inter font, TanStack Table for data tables.
5. Every screen uses the app shell: collapsible left sidebar, top bar with Cmd+K search and user menu. Later-phase menu items show "Coming soon".
6. Light and dark mode: follow the system, with a manual toggle. Check both.
7. WCAG AA contrast, full keyboard access, visible focus rings (`--ring`), responsive down to phone width.
8. Destructive or bulk actions need a confirmation dialog. Use toasts for feedback, skeleton loaders while loading and a clear empty state for empty lists.
9. Never render secrets. Show vault references or masked values only.
