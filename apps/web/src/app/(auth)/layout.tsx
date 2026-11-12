import type { ReactNode } from "react";
import { BrandLogo } from "@/components/brand-logo";

export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <BrandLogo href={null} priority imgClassName="h-14 sm:h-16" />
        </div>
        {children}
      </div>
    </main>
  );
}
