"use client";
import { CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";

/** Shows the one-off message a Server Action left behind, then clears it. */
export function Toaster({ message }: { message: string | null }) {
  const [visible, setVisible] = useState<string | null>(message);
  useEffect(() => {
    setVisible(message);
    if (!message) return;
    document.cookie = "ulx_flash=; path=/; max-age=0; samesite=strict; secure";
    const timer = setTimeout(() => setVisible(null), 4000);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50">
      {visible && (
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-sm transition-opacity duration-150">
          <CheckCircle2 aria-hidden className="size-4 text-success" />
          {visible}
        </div>
      )}
    </div>
  );
}
