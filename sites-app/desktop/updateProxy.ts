const UPDATE_PROXY_PORT_KEY = "life-strategy.update-proxy-port";

export const DEFAULT_UPDATE_PROXY_PORT = "7890";

type UpdateProxyStorage = Pick<Storage, "getItem" | "setItem">;

export function loadUpdateProxyPort(storage: UpdateProxyStorage = window.localStorage) {
  try {
    const savedPort = storage.getItem(UPDATE_PROXY_PORT_KEY);
    return savedPort === null ? DEFAULT_UPDATE_PROXY_PORT : savedPort;
  } catch {
    return DEFAULT_UPDATE_PROXY_PORT;
  }
}

export function saveUpdateProxyPort(port: string, storage: UpdateProxyStorage = window.localStorage) {
  storage.setItem(UPDATE_PROXY_PORT_KEY, port.trim());
}

export function validateUpdateProxyPort(port: string) {
  const normalized = port.trim();
  if (!normalized) return "";
  if (!/^\d+$/.test(normalized)) return "请输入 1 到 65535 之间的端口号。";

  const numericPort = Number(normalized);
  if (numericPort < 1 || numericPort > 65_535) {
    return "请输入 1 到 65535 之间的端口号。";
  }
  return "";
}

export function updateProxyUrl(port = loadUpdateProxyPort()) {
  const normalized = port.trim();
  if (!normalized || validateUpdateProxyPort(normalized)) return null;
  return `http://127.0.0.1:${normalized}`;
}
