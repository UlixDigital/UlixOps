import type { ReactNode } from "react";

export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-sm font-semibold tracking-tight">UlixOps</p>
        {children}
      </div>
    </main>
  );
}
