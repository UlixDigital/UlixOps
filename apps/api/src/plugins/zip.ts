// A deliberately small, strict ZIP reader for plugin uploads (agent decision A61). It reads the
// central directory, checks it against each local header, and inflates entries into memory with
// hard caps. Nothing is ever extracted to disk. Anything unusual is refused rather than guessed:
// ZIP64, encryption, multi-disk archives, overlapping entries, unknown compression, links.
import { crc32, inflateRawSync } from "node:zlib";

export class ZipError extends Error {}

export interface ZipLimits {
  maxEntries: number;
  /** Sum of the declared uncompressed sizes; actual output is capped by the same numbers. */
  maxTotalBytes: number;
  maxEntryBytes: number;
}

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  method: 0 | 8;
  crc32: number;
  compressedSize: number;
  size: number;
  /** Offset of the local file header. */
  localOffset: number;
  /** Unix mode bits when the archive was made on Unix, else null. */
  unixMode: number | null;
  flags: number;
  /** Where this entry's central directory record sits, for rebuilding the archive. */
  centralOffset: number;
  centralLength: number;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** Starts like a ZIP file (the MIME check: content, not the declared type). */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOCAL_SIG;
}

function findEocd(buf: Buffer): number {
  // The record is the last thing in the file, followed only by its comment (<= 65535 bytes).
  const last = buf.length - EOCD_MIN;
  for (let at = last; at >= 0 && at >= last - 0xffff; at--) {
    if (
      buf.readUInt32LE(at) === EOCD_SIG &&
      at + EOCD_MIN + buf.readUInt16LE(at + 20) === buf.length
    )
      return at;
  }
  throw new ZipError("Not a ZIP archive (no end of central directory record)");
}

function decodeName(raw: Buffer, utf8Flag: boolean): string {
  if (!utf8Flag) {
    // Without the UTF-8 flag the name is CP437; only plain ASCII is accepted.
    if (raw.some((byte) => byte > 0x7e)) throw new ZipError("File names must be ASCII or UTF-8");
    return raw.toString("latin1");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw).normalize("NFC");
  } catch {
    throw new ZipError("A file name is not valid UTF-8");
  }
}

/** Lists the entries, after checking the archive's structure. Throws ZipError when invalid. */
export function readEntries(buf: Buffer, limits: ZipLimits): ZipEntry[] {
  if (buf.length < EOCD_MIN) throw new ZipError("Not a ZIP archive (too short)");
  const eocd = findEocd(buf);
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG)
    throw new ZipError("ZIP64 archives are not accepted");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total)
    throw new ZipError("Multi-part archives are not accepted");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new ZipError("ZIP64 archives are not accepted");
  if (total === 0) throw new ZipError("The archive is empty");
  if (total > limits.maxEntries)
    throw new ZipError(`Too many files (${total}; the limit is ${limits.maxEntries})`);
  if (cdOffset + cdSize !== eocd) throw new ZipError("The central directory is out of place");

  const entries: ZipEntry[] = [];
  let at = cdOffset;
  let totalBytes = 0;
  for (let i = 0; i < total; i++) {
    if (at + 46 > eocd || buf.readUInt32LE(at) !== CENTRAL_SIG)
      throw new ZipError("The central directory is damaged");
    const madeBy = buf.readUInt16LE(at + 4);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const diskStart = buf.readUInt16LE(at + 34);
    const externalAttrs = buf.readUInt32LE(at + 38);
    const localOffset = buf.readUInt32LE(at + 42);
    const next = at + 46 + nameLen + extraLen + commentLen;
    if (next > eocd) throw new ZipError("The central directory is damaged");
    const name = decodeName(buf.subarray(at + 46, at + 46 + nameLen), (flags & 0x0800) !== 0);

    if (flags & 0x0001 || flags & 0x0040) throw new ZipError(`"${name}" is encrypted`);
    if (method !== 0 && method !== 8)
      throw new ZipError(`"${name}" uses an unsupported compression method (${method})`);
    if (diskStart !== 0 || compressedSize === 0xffffffff || size === 0xffffffff)
      throw new ZipError("ZIP64 archives are not accepted");
    if (size > limits.maxEntryBytes)
      throw new ZipError(`"${name}" is too large when unpacked (${size} bytes)`);
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes)
      throw new ZipError(`The archive unpacks to more than ${limits.maxTotalBytes} bytes`);

    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      method,
      crc32: crc,
      compressedSize,
      size,
      localOffset,
      unixMode: madeBy >> 8 === 3 ? externalAttrs >>> 16 : null,
      flags,
      centralOffset: at,
      centralLength: next - at,
    });
    at = next;
  }
  if (at !== eocd) throw new ZipError("The central directory is damaged");

  // Each entry's data must sit inside the file, before the central directory, and not overlap
  // another entry (overlapping entries are a known "zip bomb" trick).
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  let end = 0;
  for (const entry of byOffset) {
    if (entry.localOffset < end) throw new ZipError("Entries overlap");
    end = dataStart(buf, entry, cdOffset) + entry.compressedSize;
    if (end > cdOffset) throw new ZipError(`"${entry.name}" runs past the end of the data`);
  }
  return entries;
}

/** Validates the local header against the central directory and returns where data begins. */
function dataStart(buf: Buffer, entry: ZipEntry, limit: number): number {
  const at = entry.localOffset;
  if (at + 30 > limit || buf.readUInt32LE(at) !== LOCAL_SIG)
    throw new ZipError(`"${entry.name}" has no valid local header`);
  const flags = buf.readUInt16LE(at + 6);
  const method = buf.readUInt16LE(at + 8);
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const start = at + 30 + nameLen + extraLen;
  if (start > limit) throw new ZipError(`"${entry.name}" has no valid local header`);
  const name = decodeName(buf.subarray(at + 30, at + 30 + nameLen), (flags & 0x0800) !== 0);
  if (name !== entry.name || method !== entry.method || flags & 0x0001)
    throw new ZipError(`"${entry.name}" doesn't match its directory entry`);
  return start;
}

/** The entry's file type from Unix mode bits: regular, directory, or something to refuse. */
export function entryType(entry: ZipEntry): "file" | "directory" | "link" | "special" {
  const type = entry.unixMode === null ? 0 : entry.unixMode & S_IFMT;
  if (type === 0) return entry.isDirectory ? "directory" : "file";
  if (type === 0o120000) return "link";
  if (type === S_IFDIR && entry.isDirectory) return "directory";
  if (type === S_IFREG && !entry.isDirectory) return "file";
  return "special";
}

/** Inflates one entry, verifying its size and CRC-32. Output never exceeds the declared size. */
export function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const start = dataStart(buf, entry, buf.length);
  const raw = buf.subarray(start, start + entry.compressedSize);
  let data: Buffer;
  if (entry.method === 0) {
    data = raw;
  } else {
    try {
      // One byte of headroom: more output than declared means the header lied.
      data = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) + 1 });
    } catch {
      throw new ZipError(`"${entry.name}" is corrupt or larger than it claims`);
    }
  }
  if (data.length !== entry.size) throw new ZipError(`"${entry.name}" isn't the size it claims`);
  if (crc32(data) !== entry.crc32) throw new ZipError(`"${entry.name}" fails its CRC check`);
  return data;
}

const DESCRIPTOR_SIG = 0x08074b50;

/**
 * A copy of the archive holding only `keep` (entries from readEntries on the same buffer), in
 * their original order. Each kept entry's bytes are copied unchanged, so nothing is
 * recompressed; only offsets and the end record are rewritten.
 */
export function withoutEntries(buf: Buffer, entries: ZipEntry[], keep: Set<ZipEntry>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (!keep.has(entry)) continue;
    let end = dataStart(buf, entry, buf.length) + entry.compressedSize;
    // Bit 3: sizes and CRC follow the data in a descriptor (12 bytes, 16 with its signature).
    if (entry.flags & 0x0008)
      end += end + 4 <= buf.length && buf.readUInt32LE(end) === DESCRIPTOR_SIG ? 16 : 12;
    if (end > buf.length) throw new ZipError(`"${entry.name}" runs past the end of the data`);
    const local = buf.subarray(entry.localOffset, end);
    const central = Buffer.from(
      buf.subarray(entry.centralOffset, entry.centralOffset + entry.centralLength),
    );
    central.writeUInt32LE(offset, 42);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(EOCD_MIN);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
