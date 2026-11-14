import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Inspect the produced package, including space absent from its ZIP directory.
// Summing ZIP entries alone misses the large free regions left by incremental packaging.
export function analyzeApk(buffer, { abi, allowDebugSymbols = false }) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('APK ZIP directory not found');
  const directorySize = buffer.readUInt32LE(eocd + 12), directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (directoryOffset + directorySize !== eocd) throw new Error('Unexpected APK ZIP directory layout');
  let contentEnd = directoryOffset;
  if (directoryOffset >= 24 && buffer.toString('ascii', directoryOffset - 16, directoryOffset) === 'APK Sig Block 42') {
    const blockSize = Number(buffer.readBigUInt64LE(directoryOffset - 24));
    contentEnd -= blockSize + 8;
    if (contentEnd < 0 || Number(buffer.readBigUInt64LE(contentEnd)) !== blockSize) throw new Error('Invalid APK signing block');
  }
  const entries = [];
  for (let cursor = directoryOffset; cursor < eocd;) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid APK ZIP entry');
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const offset = buffer.readUInt32LE(cursor + 42), size = buffer.readUInt32LE(cursor + 20);
    if (offset + 30 > contentEnd || buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('Invalid APK local entry');
    const dataOffset = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    if (dataOffset + size > contentEnd) throw new Error('APK entry exceeds its content region');
    entries.push({ name, offset, dataOffset, end: dataOffset + size, bytes: size, method: buffer.readUInt16LE(cursor + 10) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (entries.length !== buffer.readUInt16LE(eocd + 10)) throw new Error('APK ZIP entry count mismatch');
  entries.sort((a, b) => a.offset - b.offset);
  let position = 0, unusedBytes = 0;
  for (const entry of [...entries, { offset: contentEnd, end: contentEnd }]) {
    if (entry.offset < position) throw new Error('Overlapping APK ZIP entries');
    unusedBytes += entry.offset - position;
    position = entry.end;
  }
  if (unusedBytes > 65536) throw new Error(`APK contains ${unusedBytes} unused bytes; rebuild the generated APK from scratch`);
  const libraries = entries.filter(e => e.name.startsWith('lib/') && e.name.endsWith('.so'));
  if (libraries.length !== 1 || libraries[0].name !== `lib/${abi}/liblife_strategy_library_lib.so`) throw new Error('APK contains unexpected native libraries or CPU architectures');
  const entry = libraries[0];
  let library = buffer.subarray(entry.dataOffset, entry.end);
  if (entry.method === 8) library = inflateRawSync(library);
  else if (entry.method !== 0) throw new Error('Unsupported native library compression');
  if (library.length < 64 || library.toString('hex', 0, 6) !== '7f454c460201') throw new Error('Expected a 64-bit little-endian ELF library');
  const machine = library.readUInt16LE(18);
  if (machine !== (abi === 'arm64-v8a' ? 183 : 62)) throw new Error('Native library CPU does not match the requested APK');
  const sectionOffset = Number(library.readBigUInt64LE(40)), stride = library.readUInt16LE(58), count = library.readUInt16LE(60), stringsIndex = library.readUInt16LE(62);
  if (stride < 64 || stringsIndex >= count || sectionOffset + stride * count > library.length) throw new Error('Invalid ELF section table');
  const namesStart = Number(library.readBigUInt64LE(sectionOffset + stride * stringsIndex + 24));
  const sections = [];
  for (let i = 0; i < count; i++) {
    const at = sectionOffset + stride * i, nameStart = namesStart + library.readUInt32LE(at), nameEnd = library.indexOf(0, nameStart);
    if (nameEnd < nameStart) throw new Error('Invalid ELF section name');
    sections.push({ name: library.toString('utf8', nameStart, nameEnd), bytes: Number(library.readBigUInt64LE(at + 32)) });
  }
  const debugging = sections.filter(s => s.name.startsWith('.debug') || ['.symtab', '.strtab'].includes(s.name));
  if (!allowDebugSymbols && debugging.length) throw new Error(`APK still contains debug symbols: ${debugging.map(s => s.name).join(', ')}`);
  return {
    apkBytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), abi,
    nativeBytes: library.length, dexBytes: entries.filter(e => e.name.endsWith('.dex')).reduce((n, e) => n + e.bytes, 0),
    resourceBytes: entries.filter(e => e.name.startsWith('res/') || e.name === 'resources.arsc').reduce((n, e) => n + e.bytes, 0),
    unusedBytes, debugSymbolBytes: debugging.reduce((n, s) => n + s.bytes, 0), entryCount: entries.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const abiIndex = process.argv.indexOf('--abi'), abi = process.argv[abiIndex + 1];
    if (abiIndex < 0 || !['arm64-v8a', 'x86_64'].includes(abi)) throw new Error('Pass --abi arm64-v8a or --abi x86_64');
    console.log(JSON.stringify(analyzeApk(readFileSync(process.argv[2]), { abi, allowDebugSymbols: process.argv.includes('--allow-debug-symbols') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
