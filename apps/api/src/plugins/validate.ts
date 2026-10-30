// Checks for an uploaded plugin ZIP (spec 5: size limit, MIME + structure check, scanned before
// use; agent decision A61). Runs in order and stops at the first failed check, like Test
// connection. Everything happens in memory; nothing from the archive touches the disk.
import { createHash } from "node:crypto";
import {
  MAX_PLUGIN_ZIP_BYTES,
  slug as Slug,
  type UploadCheck,
  version as Version,
} from "@ulixops/shared";
import {
  entryType,
  looksLikeZip,
  readEntries,
  readEntry,
  withoutEntries,
  ZipError,
  type ZipEntry,
} from "./zip";

export const ZIP_LIMITS = {
  maxEntries: 5000,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
};

export interface ZipCheckResult {
  ok: boolean;
  /** The bytes to keep: the upload, or a copy without macOS metadata (agent decision A66). */
  zip: Buffer;
  /** Size and SHA-256 of `zip`. */
  sizeBytes: number;
  sha256: string;
  /** The uploaded file's SHA-256 when `zip` is a cleaned copy, else null. */
  uploadedSha256: string | null;
  slug: string | null;
  name: string | null;
  version: string | null;
  requiresWp: string | null;
  requiresPhp: string | null;
  fileCount: number;
  checks: UploadCheck[];
  warnings: string[];
  notes: string[];
}

export const MAC_METADATA_NOTE = "Ignored macOS metadata (__MACOSX, .DS_Store)";

/**
 * What Finder's Compress adds: the top-level __MACOSX/ folder, .DS_Store files and "._"
 * resource forks. Such entries still pass every archive and path check before they are set
 * aside; they are never unpacked, and they are left out of the stored copy.
 */
export function isMacMetadata(name: string): boolean {
  const parts = name.replace(/\/$/, "").split("/");
  const base = parts[parts.length - 1] ?? "";
  return parts[0] === "__MACOSX" || base === ".DS_Store" || base.startsWith("._");
}

const sha256Of = (data: Buffer) => createHash("sha256").update(data).digest("hex");

// Never deployable: secrets, server configuration and native or PHP-archive executables.
const REFUSED_NAMES = new Set([
  "wp-config.php",
  ".user.ini",
  "php.ini",
  ".htpasswd",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const REFUSED_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".phar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
]);
const REFUSED_FOLDERS = new Set([".git", ".svn", ".hg", ".ssh", "__MACOSX"]);
// Allowed, but worth a second look before deploying.
const NOTED_NAMES = new Set([".htaccess"]);
const NOTED_EXTENSIONS = new Set([
  ".sh",
  ".bat",
  ".cmd",
  ".ps1",
  ".sql",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".7z",
  ".rar",
]);
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
// Common obfuscation in malicious PHP. A hint only: real malware scanning is Phase 2.
const SUSPICIOUS_PHP = [
  /\beval\s*\(\s*(base64_decode|gzinflate|gzuncompress|str_rot13)\s*\(/i,
  /\bassert\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)/i,
  /\bpreg_replace\s*\(\s*['"].*\/e['"]/i,
];

const extension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};

/**
 * A plugin header field the way WordPress reads it (get_file_data()): the first 8 KB, "\r" read
 * as a line break, an optional "<?php" before the field, then cleaned of a closing comment or tag.
 */
export function headerField(text: string, field: string): string | null {
  const head = text.slice(0, 8192).replace(/\r/g, "\n");
  const pattern = new RegExp(`^(?:[ \\t]*<\\?php)?[ \\t/*#@]*${field}:(.*)$`, "im");
  const value = pattern.exec(head)?.[1];
  if (value === undefined) return null;
  const cleaned = value.replace(/\s*(?:\*\/|\?>).*$/, "").trim();
  return cleaned || null;
}

function env(value: string | null): string | null {
  return value && /^\d+(\.\d+){0,3}$/.test(value) ? value : null;
}

/** Problems with one path, if any: traversal, absolute or odd names. */
function pathProblem(name: string): string | null {
  if (name.length > 400) return "is too long";
  if (name.startsWith("/")) return "is an absolute path";
  const control = [...name].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (control || /[\\:*?"<>|]/.test(name)) return "contains characters that aren't allowed";
  const parts = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".."))
    return "contains an empty, '.' or '..' part";
  if (parts.some((p) => p.length > 255)) return "has a part longer than 255 characters";
  return null;
}

export function checkPluginZip(buf: Buffer, filename: string): ZipCheckResult {
  const result: ZipCheckResult = {
    ok: false,
    zip: buf,
    sizeBytes: buf.length,
    sha256: sha256Of(buf),
    uploadedSha256: null,
    slug: null,
    name: null,
    version: null,
    requiresWp: null,
    requiresPhp: null,
    fileCount: 0,
    checks: [],
    warnings: [],
    notes: [],
  };
  const pass = (name: UploadCheck["name"], detail: string) => {
    result.checks.push({ name, ok: true, detail });
  };
  const fail = (name: UploadCheck["name"], detail: string) => {
    result.checks.push({ name, ok: false, detail });
    return result;
  };
  const warn = (text: string) => {
    if (result.warnings.length < 50) result.warnings.push(text.slice(0, 500));
  };

  // 1. The file itself: size, extension and content type by its first bytes.
  if (buf.length === 0) return fail("file", "The file is empty.");
  if (buf.length > MAX_PLUGIN_ZIP_BYTES)
    return fail("file", `The file is larger than ${MAX_PLUGIN_ZIP_BYTES / 1024 / 1024} MB.`);
  if (!/\.zip$/i.test(filename)) return fail("file", "The file name must end in .zip.");
  if (!looksLikeZip(buf)) return fail("file", "The content isn't a ZIP archive.");
  pass("file", `ZIP archive, ${(buf.length / 1024).toFixed(0)} KB`);

  // 2. The archive's structure.
  let entries: ZipEntry[];
  try {
    entries = readEntries(buf, ZIP_LIMITS);
  } catch (error) {
    if (error instanceof ZipError) return fail("archive", `${error.message}.`);
    throw error;
  }
  const files = entries.filter((e) => !e.isDirectory && !isMacMetadata(e.name));
  result.fileCount = files.length;
  pass(
    "archive",
    `${files.length} files, ${(entries.reduce((n, e) => n + e.size, 0) / 1024).toFixed(0)} KB unpacked`,
  );

  // 3. Every path: no traversal, no links, no duplicates.
  const seen = new Set<string>();
  for (const entry of entries) {
    const problem = pathProblem(entry.name);
    if (problem) return fail("paths", `"${entry.name.slice(0, 200)}" ${problem}.`);
    const type = entryType(entry);
    if (type === "link") return fail("paths", `"${entry.name}" is a symbolic link.`);
    if (type === "special") return fail("paths", `"${entry.name}" isn't a regular file or folder.`);
    const key = entry.name.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) return fail("paths", `"${entry.name}" appears more than once.`);
    seen.add(key);
  }
  pass("paths", "No absolute paths, '..', links or duplicate names");

  // Checked like everything else above; from here on, macOS metadata is set aside.
  const metadata = entries.filter((e) => isMacMetadata(e.name));
  const kept = entries.filter((e) => !isMacMetadata(e.name));

  // 4. Layout: one folder named after the plugin, like every WordPress plugin ZIP.
  const tops = new Set(kept.map((e) => e.name.split("/")[0] ?? ""));
  const loose = files.find((e) => !e.name.includes("/"));
  if (loose)
    return fail(
      "layout",
      `"${loose.name}" is at the top level. The ZIP must contain one folder named after the plugin (e.g. ulix-forms/), with everything inside it.`,
    );
  if (tops.size !== 1)
    return fail("layout", `The ZIP has ${tops.size} top-level folders; it must have exactly one.`);
  const folder = [...tops][0] ?? "";
  if (!Slug.safeParse(folder).success)
    return fail(
      "layout",
      `The folder "${folder.slice(0, 100)}" isn't a valid plugin slug: lower-case letters, digits and -, starting with a letter or digit.`,
    );
  result.slug = folder;
  pass("layout", `One plugin folder: ${folder}/`);

  // 5. The plugin header in a PHP file directly inside the folder.
  const candidates = files.filter((e) => /^[^/]+\/[^/]+\.php$/i.test(e.name));
  const headed: { entry: ZipEntry; text: string }[] = [];
  for (const entry of candidates) {
    let text: string;
    try {
      text = readEntry(buf, entry).subarray(0, 8192).toString("utf8");
    } catch (error) {
      if (error instanceof ZipError) return fail("plugin", `${error.message}.`);
      throw error;
    }
    if (headerField(text, "Plugin Name")) headed.push({ entry, text });
  }
  if (headed.length === 0)
    return fail(
      "plugin",
      `No PHP file in ${folder}/ has a "Plugin Name:" header, so WordPress wouldn't see a plugin.`,
    );
  if (headed.length > 1)
    return fail(
      "plugin",
      `More than one file has a plugin header (${headed.map((h) => h.entry.name).join(", ")}). Upload one plugin per ZIP.`,
    );
  const main = headed[0];
  if (!main) return result;
  const name = headerField(main.text, "Plugin Name") ?? "";
  const declared = headerField(main.text, "Version");
  if (name.length > 200)
    return fail("plugin", "The Plugin Name header is longer than 200 characters.");
  if (!declared) return fail("plugin", `${main.entry.name} has no "Version:" header.`);
  if (!Version.safeParse(declared).success)
    return fail(
      "plugin",
      `The version "${declared.slice(0, 40)}" isn't valid: letters, digits, . and -, up to 30 characters.`,
    );
  result.name = name;
  result.version = declared;
  result.requiresWp = env(headerField(main.text, "Requires at least"));
  result.requiresPhp = env(headerField(main.text, "Requires PHP"));
  if (main.entry.name !== `${folder}/${folder}.php`)
    warn(
      `The main file is ${main.entry.name}, not ${folder}/${folder}.php (allowed, but unusual).`,
    );
  pass("plugin", `${name} ${declared} (${main.entry.name})`);

  // 6. Scan: every file unpacks with the right size and CRC; no secrets or executables.
  const suspicious = new Set<number>();
  for (const entry of files) {
    const parts = entry.name.split("/");
    const base = parts[parts.length - 1] ?? "";
    const ext = extension(base);
    const envFile =
      base === ".env" || (base.startsWith(".env.") && !/^\.env\.(example|sample|dist)$/.test(base));
    if (parts.some((p) => REFUSED_FOLDERS.has(p)))
      return fail(
        "contents",
        `"${entry.name}" is inside a ${parts.find((p) => REFUSED_FOLDERS.has(p))} folder, which must not be shipped.`,
      );
    if (REFUSED_NAMES.has(base) || REFUSED_EXTENSIONS.has(ext) || envFile)
      return fail(
        "contents",
        `"${entry.name}" must not be part of a plugin (secrets, server configuration or executables).`,
      );
    if (NOTED_NAMES.has(base) || NOTED_EXTENSIONS.has(ext))
      warn(`Contains ${entry.name}: check it belongs in the release.`);
    if (parts.includes("node_modules") && !result.warnings.some((w) => w.includes("node_modules")))
      warn("Contains node_modules/: development files are usually left out of a release.");

    let data: Buffer;
    try {
      data = readEntry(buf, entry);
    } catch (error) {
      if (error instanceof ZipError) return fail("contents", `${error.message}.`);
      throw error;
    }
    if (PRIVATE_KEY.test(data.toString("latin1")))
      return fail("contents", `"${entry.name}" contains a private key.`);
    if (ext === ".php") {
      const text = data.toString("utf8");
      SUSPICIOUS_PHP.forEach((pattern, i) => {
        if (!suspicious.has(i) && pattern.test(text)) {
          suspicious.add(i);
          warn(
            `${entry.name} contains code often used to hide malware (${pattern.source.slice(0, 40)}…). Review it before deploying.`,
          );
        }
      });
    }
  }
  if (metadata.length > 0) {
    // Keep a copy without the metadata, and check that copy again from the start, so what is
    // stored (and later deployed) is exactly what was scanned.
    let clean: Buffer;
    try {
      clean = withoutEntries(buf, entries, new Set(kept));
    } catch (error) {
      if (error instanceof ZipError) return fail("contents", `${error.message}.`);
      throw error;
    }
    const again = checkPluginZip(clean, filename);
    if (!again.ok || again.notes.length > 0 || again.fileCount !== files.length)
      return fail("contents", "The archive couldn't be rebuilt without its macOS metadata.");
    result.zip = clean;
    result.sizeBytes = clean.length;
    result.uploadedSha256 = result.sha256;
    result.sha256 = again.sha256;
    result.notes.push(
      MAC_METADATA_NOTE,
      `${metadata.length} macOS ${metadata.length === 1 ? "entry was" : "entries were"} left out of the stored copy, so its checksum differs from the uploaded file's.`,
    );
  }
  pass(
    "contents",
    `All ${files.length} files unpacked and verified; no secrets or executables found`,
  );
  result.ok = true;
  return result;
}
