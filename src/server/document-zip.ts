import { inflateRawSync } from 'node:zlib';

export const MAX_OFFICE_ENTRIES = 2000;
export const MAX_OFFICE_EXPANDED_BYTES = 50 * 1024 * 1024;

/** Validate the bytes that Office readers will inflate, without extracting files. */
export function validateOfficeZip(bytes: Buffer, requiredFile: string): void {
  readOfficeZip(bytes, requiredFile, false);
}

/** Return only XML package parts after the same bounded validation as other Office readers. */
export function readOfficeXmlParts(bytes: Buffer, requiredFile: string): Map<string, Buffer> {
  return readOfficeZip(bytes, requiredFile, true);
}

function readOfficeZip(bytes: Buffer, requiredFile: string, captureXml: boolean): Map<string, Buffer> {
  const invalid = () => new Error('文档压缩结构损坏或不受支持。');
  let end = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos--) {
    if (bytes.readUInt32LE(pos) === 0x06054b50 && pos + 22 + bytes.readUInt16LE(pos + 20) === bytes.length) { end = pos; break; }
  }
  if (end < 0) throw invalid();
  const entries = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== entries || entries === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff) throw new Error('暂不支持多卷或 ZIP64 文档。');
  if (!entries || entries > MAX_OFFICE_ENTRIES) throw new Error(`文档压缩条目超过限制（${MAX_OFFICE_ENTRIES} 个）。`);
  if (centralStart + centralSize !== end) throw invalid();
  let position = centralStart, expanded = 0;
  const names = new Set<string>(), parts = new Map<string, Buffer>();
  for (let i = 0; i < entries; i++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) throw invalid();
    const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10);
    const packed = bytes.readUInt32LE(position + 20), unpacked = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28), extraLength = bytes.readUInt16LE(position + 30), commentLength = bytes.readUInt16LE(position + 32);
    const local = bytes.readUInt32LE(position + 42), next = position + 46 + nameLength + extraLength + commentLength;
    if (next > end || bytes.readUInt16LE(position + 34)) throw invalid();
    if ((flags & 1) || (flags & 64)) throw new Error('暂不支持加密文档，请先保存为未加密文件。');
    if (![0, 8].includes(method)) throw new Error('文档使用了不支持的压缩方式。');
    if ([packed, unpacked, local].includes(0xffffffff)) throw new Error('暂不支持 ZIP64 文档。');
    expanded += unpacked;
    if (expanded > MAX_OFFICE_EXPANDED_BYTES) throw new Error('文档解压后的内容超过 50 MiB 限制。');
    for (let p = position + 46 + nameLength; p < position + 46 + nameLength + extraLength;) {
      if (p + 4 > next) throw invalid();
      if (bytes.readUInt16LE(p) === 1) throw new Error('暂不支持 ZIP64 文档。');
      p += 4 + bytes.readUInt16LE(p + 2);
      if (p > position + 46 + nameLength + extraLength) throw invalid();
    }
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength), name = nameBytes.toString('utf8');
    if (names.has(name)) throw invalid();
    names.add(name);
    if (local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw invalid();
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28), dataStart = local + 30 + localNameLength + localExtraLength;
    if (dataStart + packed > centralStart || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) throw invalid();
    if (!(flags & 8) && (bytes.readUInt32LE(local + 18) !== packed || bytes.readUInt32LE(local + 22) !== unpacked)) throw invalid();
    const compressed = bytes.subarray(dataStart, dataStart + packed);
    try {
      const actual = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, unpacked + 1) });
      if (actual.length !== unpacked) throw invalid();
      if (captureXml && /\.(?:xml|rels)$/.test(name)) parts.set(name, actual);
    } catch { throw new Error('文档压缩内容损坏或超过声明的展开大小。'); }
    position = next;
  }
  if (position !== end || !names.has(requiredFile)) throw new Error('文件内容与文档格式不符，或文档已损坏。');
  return parts;
}
