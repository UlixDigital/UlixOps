// Builds ZIP files byte by byte for tests, including deliberately broken or hostile ones.
import { crc32, deflateRawSync } from "node:zlib";

export interface TestEntry {
  name: string;
  data?: string | Buffer;
  method?: 0 | 8;
  /** Unix mode (e.g. 0o120777 for a symlink); written with "made by Unix". */
  unixMode?: number;
  flags?: number;
  /** Lie about the uncompressed size or CRC in both headers. */
  size?: number;
  crc?: number;
  /** Name written in the local header, if different (header mismatch). */
  localName?: string;
  /** Stream style, like macOS Archive Utility: sizes and CRC in a descriptor after the data. */
  descriptor?: boolean;
}

export function makeZip(
  entries: TestEntry[],
  opts: { overlap?: boolean; zip64Locator?: boolean; trailing?: Buffer } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let firstOffset = 0;
  entries.forEach((entry, index) => {
    const raw = Buffer.from(entry.data ?? "");
    const method = entry.method ?? (entry.name.endsWith("/") ? 0 : 8);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, "utf8");
    const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const flags = (entry.flags ?? 0) | 0x0800 | (entry.descriptor ? 0x0008 : 0);
    const crc = entry.crc ?? crc32(raw);
    const size = entry.size ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!entry.descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(size, 22);
    }
    const descriptor = Buffer.alloc(entry.descriptor ? 16 : 0);
    if (entry.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    local.writeUInt16LE(localName.length, 26);
    const thisOffset = opts.overlap && index > 0 ? firstOffset : offset;
    if (index === 0) firstOffset = offset;
    if (!(opts.overlap && index > 0)) {
      locals.push(local, localName, body, descriptor);
      offset += local.length + localName.length + body.length + descriptor.length;
    }

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.unixMode === undefined ? 0 : (entry.unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(thisOffset, 42);
    centrals.push(central, name);
  });
  const cd = Buffer.concat(centrals);
  const locator = Buffer.alloc(opts.zip64Locator ? 20 : 0);
  if (opts.zip64Locator) locator.writeUInt32LE(0x07064b50, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  if (opts.zip64Locator) {
    // The locator sits between the central directory and the EOCD.
    eocd.writeUInt32LE(cd.length, 12);
    return Buffer.concat([...locals, cd, locator, eocd]);
  }
  return Buffer.concat([...locals, cd, eocd, opts.trailing ?? Buffer.alloc(0)]);
}

export const pluginPhp = (name = "Ulix Forms", version = "1.2.0", extra = "") =>
  `<?php\n/**\n * Plugin Name: ${name}\n * Version: ${version}\n * Requires at least: 6.4\n * Requires PHP: 8.1\n${extra} */\n`;

/** A valid plugin ZIP: ulix-forms/ with a main file and an include. */
export function pluginZip(
  opts: { slug?: string; version?: string; files?: TestEntry[] } = {},
): Buffer {
  const slug = opts.slug ?? "ulix-forms";
  return makeZip([
    { name: `${slug}/` },
    { name: `${slug}/${slug}.php`, data: pluginPhp("Ulix Forms", opts.version ?? "1.2.0") },
    { name: `${slug}/includes/form.php`, data: "<?php\nfunction ulix_form() { return 1; }\n" },
    ...(opts.files ?? []),
  ]);
}

/** AppleDouble header, the start of every "._" file macOS writes. */
const APPLE_DOUBLE = Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]);

/**
 * What Finder's "Compress" makes of a plugin folder: streamed entries, a .DS_Store, and a
 * top-level __MACOSX/ folder with "._" resource forks for files that have extended attributes.
 */
export function finderZip(extra: TestEntry[] = []): Buffer {
  const finder = (e: TestEntry): TestEntry => ({
    unixMode: e.name.endsWith("/") ? 0o040755 : 0o100644,
    descriptor: !e.name.endsWith("/"),
    ...e,
  });
  return makeZip(
    [
      { name: "ulix-forms/" },
      { name: "ulix-forms/ulix-forms.php", data: pluginPhp() },
      { name: "ulix-forms/.DS_Store", data: Buffer.from("Bud1\0\0\0\x01DSDB") },
      { name: "ulix-forms/includes/" },
      { name: "ulix-forms/includes/form.php", data: "<?php\nfunction ulix_form() { return 1; }\n" },
      { name: "ulix-forms/includes/.DS_Store", data: Buffer.from("Bud1") },
      { name: "__MACOSX/" },
      { name: "__MACOSX/ulix-forms/" },
      {
        name: "__MACOSX/ulix-forms/._ulix-forms.php",
        data: Buffer.concat([APPLE_DOUBLE, Buffer.alloc(74)]),
      },
      { name: "__MACOSX/ulix-forms/includes/" },
      {
        name: "__MACOSX/ulix-forms/includes/._form.php",
        data: Buffer.concat([APPLE_DOUBLE, Buffer.alloc(74)]),
      },
      ...extra,
    ].map(finder),
  );
}
