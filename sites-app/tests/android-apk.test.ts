import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { analyzeApk } from "../scripts/check-android-apk.mjs";

function elf(debug = false) {
  const count = debug ? 4 : 3, names = Buffer.from("\0.text\0.shstrtab\0.debug_info\0");
  const namesOffset = 64 + count * 64, data = namesOffset + names.length;
  const buffer = Buffer.alloc(data + 8);
  Buffer.from("7f454c460201", "hex").copy(buffer);
  buffer.writeUInt16LE(183, 18); buffer.writeBigUInt64LE(64n, 40);
  buffer.writeUInt16LE(64, 58); buffer.writeUInt16LE(count, 60); buffer.writeUInt16LE(2, 62);
  buffer.writeUInt32LE(1, 128); buffer.writeUInt32LE(1, 132); buffer.writeBigUInt64LE(6n, 136);
  buffer.writeBigUInt64LE(BigInt(data), 152); buffer.writeBigUInt64LE(4n, 160);
  buffer.writeUInt32LE(7, 192); buffer.writeUInt32LE(3, 196);
  buffer.writeBigUInt64LE(BigInt(namesOffset), 216); buffer.writeBigUInt64LE(BigInt(names.length), 224);
  if (debug) { buffer.writeUInt32LE(17, 256); buffer.writeUInt32LE(1, 260); buffer.writeBigUInt64LE(BigInt(data + 4), 280); buffer.writeBigUInt64LE(4n, 288); }
  names.copy(buffer, namesOffset);
  return buffer;
}
function apk({ debug = false, padding = 4096, abi = "arm64-v8a", compressed = false } = {}) {
  const name = Buffer.from(`lib/${abi}/liblife_strategy_library_lib.so`), library = elf(debug);
  const content = compressed ? deflateRawSync(library) : library;
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(compressed ? 8 : 0, 8);
  local.writeUInt32LE(content.length, 18); local.writeUInt32LE(library.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(compressed ? 8 : 0, 10);
  central.writeUInt32LE(content.length, 20); central.writeUInt32LE(library.length, 24); central.writeUInt16LE(name.length, 28); name.copy(central, 46);
  const signing = Buffer.alloc(32); signing.writeBigUInt64LE(24n); signing.writeBigUInt64LE(24n, 8); signing.write("APK Sig Block 42", 16);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length + content.length + padding + signing.length, 16);
  return Buffer.concat([local, content, Buffer.alloc(padding), signing, central, eocd]);
}

test("APK delivery accepts normal alignment and signing while measuring uncompressed or compressed native code", () => {
  for (const compressed of [false, true]) {
    const result = analyzeApk(apk({ compressed }), { abi: "arm64-v8a" });
    assert.equal(result.unusedBytes, 4096); assert.equal(result.nativeBytes, elf().length);
    assert.equal(result.debugSymbolBytes, 0); assert.equal(result.entryCount, 1);
  }
});
test("APK delivery rejects incremental packaging holes, retained debug symbols and wrong CPU libraries", () => {
  assert.throws(() => analyzeApk(apk({ padding: 100000 }), { abi: "arm64-v8a" }), /unused bytes/);
  assert.throws(() => analyzeApk(apk({ debug: true }), { abi: "arm64-v8a" }), /debug symbols/);
  assert.equal(analyzeApk(apk({ debug: true }), { abi: "arm64-v8a", allowDebugSymbols: true }).debugSymbolBytes, 4);
  assert.throws(() => analyzeApk(apk({ abi: "x86_64" }), { abi: "arm64-v8a" }), /CPU architectures/);
  assert.throws(() => analyzeApk(apk({ abi: "x86_64" }), { abi: "x86_64" }), /CPU does not match/);
  assert.throws(() => analyzeApk(Buffer.from("invalid archive"), { abi: "arm64-v8a" }), /directory not found/);
});
