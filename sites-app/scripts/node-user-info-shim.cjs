const os = require("node:os");

const preloadOption = `--require=${JSON.stringify(__filename)}`;
if (!process.env.NODE_OPTIONS?.includes(__filename)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preloadOption].filter(Boolean).join(" ");
}

try {
  os.userInfo();
} catch {
  os.userInfo = () => ({
    uid: -1,
    gid: -1,
    username: process.env.USERNAME || "local-user",
    homedir: process.env.USERPROFILE || os.homedir(),
    shell: null,
  });
}
