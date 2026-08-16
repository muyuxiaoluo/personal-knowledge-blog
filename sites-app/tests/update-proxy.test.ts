import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_UPDATE_PROXY_PORT,
  loadUpdateProxyPort,
  saveUpdateProxyPort,
  updateProxyUrl,
  validateUpdateProxyPort,
} from "../desktop/updateProxy";

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: () => value,
    setItem: (_key: string, nextValue: string) => { value = nextValue; },
  };
}

test("update proxy defaults to the common local proxy port", () => {
  assert.equal(loadUpdateProxyPort(memoryStorage()), DEFAULT_UPDATE_PROXY_PORT);
  assert.equal(updateProxyUrl(DEFAULT_UPDATE_PROXY_PORT), "http://127.0.0.1:7890");
});

test("update proxy accepts valid ports and rejects invalid values", () => {
  assert.equal(validateUpdateProxyPort(" 10809 "), "");
  assert.equal(updateProxyUrl(" 10809 "), "http://127.0.0.1:10809");
  assert.match(validateUpdateProxyPort("0"), /1 到 65535/);
  assert.match(validateUpdateProxyPort("65536"), /1 到 65535/);
  assert.match(validateUpdateProxyPort("abc"), /1 到 65535/);
});

test("a blank saved value disables the explicit update proxy", () => {
  const storage = memoryStorage();
  saveUpdateProxyPort("   ", storage);
  assert.equal(loadUpdateProxyPort(storage), "");
  assert.equal(updateProxyUrl(""), null);
});
