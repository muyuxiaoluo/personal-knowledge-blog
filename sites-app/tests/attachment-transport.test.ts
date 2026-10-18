import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentBlobEndpoint,
  attachmentNativeTransportFailed,
} from "../app/data/attachment-repository";

test("attachment fallback recognizes the native request failure shown by the desktop app", () => {
  assert.equal(attachmentNativeTransportFailed(
    "无法检查云端附件：error sending request for url (https://example.test/v3/blobs/hash)",
  ), true);
  assert.equal(attachmentNativeTransportFailed(
    "检查云端附件无法连接同步服务器，请检查网络、系统代理或安全证书后重试。",
  ), true);
  assert.equal(attachmentNativeTransportFailed("待上传附件超过大小限制。"), false);
});

test("attachment fallback builds a canonical blob endpoint", () => {
  assert.equal(
    attachmentBlobEndpoint("https://example.test/custom/path?old=1", "A".repeat(64)),
    `https://example.test/v3/blobs/${"a".repeat(64)}`,
  );
  assert.throws(() => attachmentBlobEndpoint("file:///tmp/server", "a".repeat(64)), /地址无效/);
});
