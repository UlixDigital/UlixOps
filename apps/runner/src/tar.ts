// Minimal ustar pack/unpack for plugin folders over SSH when SFTP is unavailable (A99).
// Paths up to 255 bytes use the ustar prefix field; GNU LongLink / pax headers are read on unpack (A102).
const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
const PATH_MAX = NAME_MAX + 1 + PREFIX_MAX; // 256 with slash; ustar effective max 255

export interface TarFile {
  path: string;
  data: Buffer;
}

/** Pack relative files into an uncompressed ustar archive. */
export function packTar(files: readonly TarFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const name = normalizeTarPath(file.path);
    if (!name) throw new Error(`Bad tar path: ${file.path}`);
    const split = splitUstarPath(name);
    parts.push(tarHeader(split.name, split.prefix, file.data.length, false));
    parts.push(file.data);
    const pad = (BLOCK - (file.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** Unpack a ustar / GNU / pax archive into relative files. Skips directories. */
export function unpackTar(data: Buffer, maxFiles: number, maxTotalBytes: number): TarFile[] {
  const files: TarFile[] = [];
  let total = 0;
  let offset = 0;
  let pendingLongName: string | null = null;
  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (isZeroBlock(header)) {
      // End of archive (two zero blocks); stop.
      break;
    }
    const size = parseOctal(header.subarray(124, 136));
    const type = header[156] === 0 ? 0 : header[156];
    const fileData = data.subarray(offset, offset + size);
    offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);

    // GNU long name: next regular header's path is in this entry's data.
    if (type === 76 /* 'L' */) {
      pendingLongName = fileData.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    // Pax extended header may carry path=.
    if (type === 120 /* 'x' */ || type === 88 /* 'X' */) {
      const path = paxPath(fileData.toString("utf8"));
      if (path) pendingLongName = path;
      continue;
    }
    // Skip GNU long link name and other non-files.
    if (type === 75 /* 'K' */) {
      pendingLongName = null;
      continue;
    }
    if (type !== 0 && type !== 48 /* '0' */) {
      pendingLongName = null;
      continue;
    }

    const rawName = pendingLongName ?? readTarName(header);
    pendingLongName = null;
    const name = normalizeTarPath(rawName);
    if (!name || name.endsWith("/")) continue;
    if (files.length >= maxFiles) throw new Error("Too many files in plugin folder");
    total += fileData.length;
    if (total > maxTotalBytes) throw new Error("Plugin folder exceeds size limit");
    files.push({ path: name, data: Buffer.from(fileData) });
  }
  return files;
}

function normalizeTarPath(raw: string): string {
  const name = raw
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
  if (!name || name.includes("..") || name.startsWith("/")) return "";
  return name;
}

/** Split a path across ustar name (100) + prefix (155). Never silently truncates (A102). */
export function splitUstarPath(path: string): { name: string; prefix: string } {
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes <= NAME_MAX) return { name: path, prefix: "" };
  if (bytes > PATH_MAX - 1) {
    throw new Error(`Tar path too long (${bytes} bytes): ${path}`);
  }
  // Prefer a slash split so name ≤ 100 and prefix ≤ 155.
  for (let i = Math.min(path.length - 1, PREFIX_MAX); i >= 1; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (
      name.length > 0 &&
      Buffer.byteLength(prefix, "utf8") <= PREFIX_MAX &&
      Buffer.byteLength(name, "utf8") <= NAME_MAX
    ) {
      return { prefix, name };
    }
  }
  throw new Error(`Tar path cannot be split for ustar: ${path}`);
}

function tarHeader(name: string, prefix: string, size: number, isDir: boolean): Buffer {
  const header = Buffer.alloc(BLOCK);
  const nameBuf = Buffer.from(name, "utf8");
  const prefixBuf = Buffer.from(prefix, "utf8");
  if (nameBuf.length > NAME_MAX) throw new Error(`Tar name too long: ${name}`);
  if (prefixBuf.length > PREFIX_MAX) throw new Error(`Tar prefix too long: ${prefix}`);
  nameBuf.copy(header, 0);
  header.write("0000644\0", 100, 8, "utf8"); // mode
  header.write("0000000\0", 108, 8, "utf8"); // uid
  header.write("0000000\0", 116, 8, "utf8"); // gid
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0")}\0`,
    136,
    12,
    "utf8",
  );
  header.write("        ", 148, 8, "utf8"); // checksum blank
  header[156] = isDir ? 53 /* '5' */ : 48; /* '0' */
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  if (prefixBuf.length) prefixBuf.copy(header, 345);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i] ?? 0;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  return header;
}

function readTarName(header: Buffer): string {
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
  const base = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  return prefix ? `${prefix}/${base}` : base;
}

function paxPath(body: string): string | null {
  // Records look like: `<len> path=<value>\n`
  for (const line of body.split("\n")) {
    const match = /^(\d+) path=(.*)$/.exec(line);
    if (match?.[2] !== undefined) return match[2];
  }
  return null;
}

function parseOctal(buf: Buffer): number {
  const text = buf.toString("utf8").replace(/\0.*$/, "").trim();
  if (!text) return 0;
  return Number.parseInt(text, 8) || 0;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}
