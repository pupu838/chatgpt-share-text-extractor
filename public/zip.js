// Minimal ZIP writer for already-compressed PNG files. No CDN needed.
const encoder = new TextEncoder();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function view(size) { return new DataView(new ArrayBuffer(size)); }
function u8(data) { return new Uint8Array(data.buffer); }

export async function createZip(files) {
  if (!files.length) throw new Error('没有可以打包的图片。');
  if (files.length > 65535) throw new Error('图片数量超出 ZIP 支持范围。');
  const parts = [], central = [];
  let offset = 0;
  for (const file of files) {
    const filename = encoder.encode(file.name);
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    if (bytes.length > 0xffffffff) throw new Error('单张图片过大。');
    const crc = crc32(bytes);
    const local = view(30);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, filename.length, true);
    parts.push(u8(local), filename, bytes);
    const dir = view(46);
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, bytes.length, true);
    dir.setUint32(24, bytes.length, true);
    dir.setUint16(28, filename.length, true);
    dir.setUint32(42, offset, true);
    central.push(u8(dir), filename);
    offset += 30 + filename.length + bytes.length;
    if (offset > 0xffffffff) throw new Error('ZIP 总大小超过 4 GB。');
  }
  const centralOffset = offset;
  const centralSize = central.reduce((sum, item) => sum + item.byteLength, 0);
  const end = view(22);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralOffset, true);
  return new Blob([...parts, ...central, u8(end)], { type: 'application/zip' });
}
