# Tauri Plugin companion-secrets

仅供本仓库伴侣应用使用。允许 `companion_session` 和 `private_<64位账户哈希>` 两类安全存储项。
Windows 使用 Credential Manager；Android 使用 AndroidKeyStore 的 AES-256-GCM 包装密钥，私有 preferences 只存 IV 与认证密文，存储项名作为 AAD。API 的错误不包含输入值。
Android 包名为 `com.muyuxiaoluo.companionsecrets`，只暴露 get/set/remove，不提供任意文件、HTTP 或系统凭据访问。
应用清单必须同时禁用系统/设备迁移备份。此库不负责恢复码生成、账户认证或私人同步协议，它们属于共享领域层。
