import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

/** UlixOps system mark / wordmark (owner brand assets). */
export function BrandLogo({
  compact = false,
  href = "/",
  className,
  imgClassName,
  priority = false,
}: {
  /** Collapsed sidebar: circular U mark only. */
  compact?: boolean;
  href?: string | null;
  className?: string;
  imgClassName?: string;
  priority?: boolean;
}) {
  const img = compact ? (
    <Image
      src="/brand/ulixops-mark.png"
      alt="UlixOps"
      width={40}
      height={40}
      className={cn("size-10", imgClassName)}
      priority={priority}
    />
  ) : (
    <Image
      src="/brand/ulixops-wordmark.png"
      alt="UlixOps"
      width={200}
      height={55}
      className={cn("h-10 w-auto max-w-full", imgClassName)}
      priority={priority}
    />
  );

  if (!href) {
    return <span className={cn("inline-flex items-center", className)}>{img}</span>;
  }

  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      title="UlixOps"
    >
      {img}
    </Link>
  );
}
