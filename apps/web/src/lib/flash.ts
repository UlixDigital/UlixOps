import "server-only";
import { cookies } from "next/headers";

export const FLASH_COOKIE = "ulx_flash";

/** One-off success message, shown as a toast on the next render (Server Actions only). */
export async function setFlash(message: string): Promise<void> {
  (await cookies()).set(FLASH_COOKIE, message.slice(0, 200), {
    path: "/",
    maxAge: 30,
    sameSite: "strict",
    secure: true,
    // Read and cleared by the toast in the browser; it never holds anything sensitive.
    httpOnly: false,
  });
}

export async function readFlash(): Promise<string | null> {
  return (await cookies()).get(FLASH_COOKIE)?.value || null;
}
