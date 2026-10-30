// Minimal store-only ZIP writer/reader (no compression, no ZIP64). Avoids a new dependency
// for quick snapshots (agent decision A67). Enough for plugin folders and a SQL dump.
import { inflateRawSync } from "node:zlib";

export type ZipFiles = Map<string, Buffer>;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

/** Build an uncompressed ZIP from path → bytes. Paths use forward slashes, no leading /. */
export function zipStore(files: ZipFiles): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [rawName, data] of files) {
    const name = rawName.replace(/^\/+/, "").replace(/\\/g, "/");
    if (!name || name.includes("..") || name.length > 500) throw new Error(`Bad zip path: ${name}`);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length + data.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    data.copy(local, 30 + nameBuf.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, end]);
}

/** Read a store-or-deflate ZIP into path → bytes. Refuses traversal and absolute paths. */
export function unzipStore(data: Buffer): ZipFiles {
  const end = findEnd(data);
  const count = end.readUInt16LE(10);
  const centralSize = end.readUInt32LE(12);
  const centralOffset = end.readUInt32LE(16);
  if (centralOffset + centralSize > data.length) throw new Error("Corrupt ZIP central directory");
  const out: ZipFiles = new Map();
  let pos = centralOffset;
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(pos) !== SIG_CENTRAL) throw new Error("Corrupt ZIP central header");
    const method = data.readUInt16LE(pos + 10);
    const compSize = data.readUInt32LE(pos + 20);
    const uncompSize = data.readUInt32LE(pos + 24);
    const nameLen = data.readUInt16LE(pos + 28);
    const extraLen = data.readUInt16LE(pos + 30);
    const commentLen = data.readUInt16LE(pos + 32);
    const localOffset = data.readUInt32LE(pos + 42);
    const name = data.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith("/")) continue;
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) {
      throw new Error(`Refused zip path: ${name}`);
    }
    if (data.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error("Corrupt ZIP local header");
    const localNameLen = data.readUInt16LE(localOffset + 26);
    const localExtraLen = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = data.subarray(start, start + compSize);
    let body: Buffer;
    if (method === 0) body = Buffer.from(raw);
    else if (method === 8) body = inflateRawSync(raw);
    else throw new Error(`Unsupported ZIP method ${method}`);
    if (body.length !== uncompSize) throw new Error("ZIP size mismatch");
    out.set(name, body);
  }
  return out;
}

function findEnd(data: Buffer): Buffer {
  // End-of-central-directory is at the end (no comment expected).
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 1024); i--) {
    if (data.readUInt32LE(i) === SIG_END) return data.subarray(i, i + 22);
  }
  throw new Error("ZIP end record not found");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    const entry = CRC_TABLE[(c ^ byte) & 0xff] ?? 0;
    c = entry ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
