# Android 个人工作台

## 当前统一版本（2026-10-26）

Android 只维护和交付一个“个人工作台”应用，健康、餐食与财富共用 `sites-app/mobile` 入口、同一个本机资料库和私人同步账户。功能开发中的候选包属于同一应用的不同构建快照。

- 健康：睡眠、步数、活动与餐食文字记录。
- 餐食：拍照或从相册选图、核对日期餐次、本机保存；可开启餐食照片加密同步，电脑端点击后识别。
- 财富：微信支付 / 招行 App 通知金额采集、即时补全提示、22:00 待补全提醒、重复候选确认与手工记账。
- 账户：统一登录、私人数据配对、照片同步开关和通知采集设置。

运行 `npm run android:build`，统一输出 `deploy-artifacts/android/personal-workbench-arm64.apk`；模拟器包输出同目录 `personal-workbench-x86_64.apk`。默认是启用 Rust 优化、R8 和资源缩减的本地签名测试包，移除调试符号；保留既有测试签名以支持覆盖安装，不属于商店发布。开发调试可显式运行 `npm run android:build:debug`。后续新增手机功能继续加入同一入口，通过这一个构建命令交付，不再另发按功能命名的 APK。

应用 ID 始终为 `com.muyuxiaoluo.workbench`，名称为“个人工作台”。已核对先前餐食与财富候选包使用相同 ID 和签名，可以直接覆盖安装，保留本机数据；无需卸载。旧 `android-mvp`、`finance-capture` 目录中的 APK 仅供历史排查，日常安装使用上述统一位置。实体小米手机的相机/相册返回和真实通知内容仍需实测。

本轮统一构建验证：24 项餐食、财富采集和私人同步测试通过，手机类型检查与前端构建通过，ARM64 / x86_64 原生打包及 ARM64 签名校验通过。隔离模拟器用户中实际覆盖安装，旧的 5 条通知证据、消费补全与关联状态均保留；同一个 APP 可进入健康、手工消费、餐食和通知待补全页面，合成餐食照片经页面保存后可重新查看，各页无横向溢出。测试用户未开启私人同步，未上传测试资料。

优化后 ARM64 测试包大小为 10,104,860 字节（10.10 MB / 9.64 MiB），SHA-256：`edb9a1fc92276e6ee93e6b979daaab642a0cc5e696832a03cf9f35e16c5d68ee`。两次默认构建的大小和 SHA-256 均一致。打包检查确认异常空白与调试符号均为零，签名和 16 KB 原生库对齐通过；R8 映射单独保存在交付目录，不装入 APK。

本轮缩减回归：26 项打包、餐食、财富及私人同步测试通过。隔离模拟器中用真实 release 优化 APK 覆盖原 debug 应用，验证旧通知关联、照片和 Keystore 凭据保留，健康与手工消费保存、餐食照片保存 / 重开、消费补全、凭据增读删，以及后台合成银行通知入库。即时通知具有两个操作，22:00 闹钟登记正常；不代表已验证实体机省电行为或实际晚间投递。详细测量见 [体积分析与修正结果](android-apk-size-analysis-2026-10-26.md)。

## 原 MVP 记录

2026-10-26 补充：手机伴侣已增加微信支付 / 招行 App 交易通知采集、待补全列表、跨来源关联确认、即时与 22:00 晚间提醒；相关金额、补全和关联状态纳入私人同步。通知采集与提醒通过原生后台组件运行，云端同步仍由打开应用、回前台、保存补全或手动操作触发。启用前需双端更新。完整使用范围与验证记录见 [交易通知采集与补全](finance-notification-capture.md)。下文的首版范围为原 MVP 记录。

## 使用与数据边界

手机只打开 `sites-app/mobile`：健康日记、四餐和手工消费。SQLite 及健康/财富 Repository 与桌面共用，不初始化 DesktopApp、文章库、AI、账单导入、系统托盘或后台常驻任务。项目列表暂不下发手机；已有消费的项目关联会保留，可在桌面调整。睡眠支持实际总时长和可选的入睡/起床时间，起止时间成对填写并按起床日期归档，跨夜无需换算日期；两端共享原有 `sleep_start`、`sleep_end` 字段。

账户由同步服务器首次部署时创建，没有公开注册入口。桌面与手机使用相同账户密码；忘记密码需由服务器管理员恢复，不能清空本机或云端数据。登录被拒绝、会话过期、网络不可用以及服务器不支持 v4 分别提示，不再把密码错误统一显示为“登录已失效”。

1. 在升级后的桌面端登录原个人同步账户，打开账户设置中的“私人数据同步”。
2. 首次创建恢复码并妥善抄录；阅读历史数据范围并勾选确认，再开启同步。恢复码是随机 256 位主密钥的编码，不是账户密码。启用后关闭显示；需要再次配对时可先关闭私人同步，在同一台可信桌面重新显示本机恢复码。
3. 手机使用相同 HTTPS 服务器和已有用户名、密码登录；粘贴桌面恢复码，确认范围后开启。配对前服务端校验非敏感密钥指纹，错误码不会绑定本机同步状态。
4. 保存首先写本机数据库，网络不影响保存。启动、回前台、保存和手动操作触发同步。冲突页显示两侧摘要，用户选择保留本机或云端；第一版保守地将同条记录的并发编辑都视作冲突，不自动合并字段。

仅同步 `health_daily_logs`、`health_meals`、`finance_transactions WHERE import_batch_id IS NULL`。不上传健康档案、AI 报告、预算、收入设置、分类规则、导入批次/文件指纹、API Key、外观配置。空餐食会删除原餐食并登记 tombstone。批量账单的去重、撤销和退款关联维持原有流程。

关闭私人同步保留数据与队列，只停止新网络同步。退出账户先撤销原 refresh session，再删除本机会话凭据；离线无法撤销时提示联网重试。本机健康与消费记录、配对密钥均保留。第一版不提供“清除全部本机数据”按钮，避免与退出混淆。一份本机资料库只能绑定一个私人同步账户，不能通过换账户自动上传旧数据。

## 架构与协议

- `app/data/private-crypto.ts`：Web Crypto 的 AES-256-GCM；每次使用系统 CSPRNG 生成 96 位 nonce；HKDF-SHA256 分离加密密钥与 HMAC 标识密钥。AAD 绑定版本、算法、密钥指纹和远端 ID。未知版本、错误密钥、nonce/ciphertext/AAD 篡改全部拒绝。远端 ID 为 HMAC-SHA256(结构化 JSON 的实体名与主键数组)，日期、餐次和金额不进入服务端标识。
- `private-repository.ts`：幂等新表迁移和三类表的增删改触发器。每次领域写入与 journal 在同一 SQLite 事务中完成；日记和四餐继续使用原 `saveDay` 原子事务。单调递增本地修订号防止上传期间的新编辑被旧回执清除。冻结的 `private_requests` 保存随机 mutation ID 和加密信封，使断网重试发送完全相同请求。
- 收包先对整页完成解密和结构校验，再在同一事务中应用记录、回执、冲突与独立 cursor。应用远端期间的触发器抑制标记位于该事务内部，其他写连接不能观察到临时状态。未解决冲突不静默覆盖本机数据。
- `POST /v4/private/pair` 校验/首次建立账户的密钥指纹；`POST /v4/private/sync` 沿用现有 Bearer access token。v4 使用独立 vault、record、change、receipt 表，不加入 v3 allowlist，也不会出现在旧 v3 响应中。此变更补齐 v3 客户端本来遗漏的 `task_plan_history` 和 `daily_situation` 解析项。
- 服务端只保存加密信封（version、algorithm、keyId、nonce、ciphertext），以及不可读 ID、版本、幂等回执和服务端时间。实体种类、操作/删除标记及业务内容均在密文内。私人接口错误和日志不返回输入正文。服务端仍可观察账户、请求时间、记录数量、密文长度和稳定标识；不提供流量隐藏或服务器恶意回滚防护。
- 维护任务沿用默认 90 天历史压缩窗口，删除被更新版本替代的旧私人 change，保留每条记录最新信封（包括 tombstone），防止长时间离线设备复活已删除数据。第一版保留幂等回执；未提供密钥轮换或云端私人库重置接口。

## 凭据与 Android

`SecretStore` 只允许伴侣会话和账户哈希命名的私人密钥。Windows 继续使用系统 Credential Manager，原桌面 refresh session 的格式/存储保持兼容。Android 使用范围很小的本地 Tauri Kotlin 插件：AndroidKeyStore 中不可导出的 AES-256 包装密钥，系统随机 IV 的 AES-GCM 对 refresh token 和恢复码进行认证加密，只有密文保存于私有 preferences，AAD 绑定存储项名。密码不持久化，access token 仅内存保存。

平台配置为 `src-tauri/tauri.android.conf.json`。手机应用 ID 为 `com.muyuxiaoluo.workbench`，桌面 ID 保持原值。手机只授予 INTERNET、ACCESS_NETWORK_STATE，以及 Tauri core、SQLite 与本地凭据插件权限。生产同步只接受 HTTPS、不跟随重定向、不关闭证书校验。Android 清单已禁用系统备份、设备迁移备份和明文网络，避免 SQLite 通过系统备份离开设备。状态栏/底部安全区与软键盘由原生 insets 避让；输入字号 16px、操作至少 48px，返回键使用 WebView 历史。图标复用桌面项目现有图标。

## 构建与验证

在 `sites-app`：

```powershell
npm run check
npm run desktop:build
npm run mobile:build
cd src-tauri
cargo test
```

在 `sync-server` 运行 `npm test`。私人客户端测试用两套独立 SQLite 模拟手机/桌面，第三套 SQLite 执行真实服务端 v4 代码；HTTP 测试验证原账户认证、v3 隔离、跨账户隔离、明文拒绝和配对校验。它们不是 Android 设备测试。

Android 工程已初始化并纳入仓库。准备 JDK 21、Android SDK platform 36、build-tools、NDK 和 Rust targets 后，在 `sites-app`：

```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.9.10-hotspot'
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME="$env:ANDROID_HOME\ndk\28.2.13676358"
rustup target add aarch64-linux-android x86_64-linux-android
npm run android:build
# 模拟器通常使用 x86_64：
npm run android:build -- -Targets x86_64
```

`scripts/build-android.ps1` 默认生成 release 优化的本地签名 APK，不生成商店签名、不发布。每次只移除对应架构 / 构建类型的自动生成 APK，强制重新封装，保留编译缓存以避免 ZIP 增量替换留下大块空白。Windows 缺少符号链接权限时，仅在日志确认原生编译成功且只因符号链接失败后，使用该库副本进行 Gradle 打包；其他编译失败仍会中止。复制到交付位置前，必须通过新旧签名一致、签名有效性、16 KB 对齐、CPU 架构、ZIP 空白和 ELF 调试段检查。优化参数只作用于本次 Android 命令，不改变桌面编译配置。通常无需再次运行 `tauri android init`，重新生成后必须保留清单、网络 / 备份规则、Gradle 缩减与本地签名配置和 MainActivity 的修改。

缩减后的安装包不开放 WebView 调试。`scripts/build-companion-instrumentation.ps1` 生成独立的同签名 Android 测试夹具；`scripts/run-companion-instrumentation.mjs` 仅允许既有 `FinanceCaptureTest` 模拟器用户 10，在真实安装的 Tauri WebView 内检查页面与插件。夹具不装入交付 APK，不应安装到实体手机。`tests/android-companion-instrumentation/smoke.js` 需要此前合成通知、照片和测试凭据基线，验证时私人同步必须关闭，禁止使用生产账户或真实财务数据。

本次验证（2026-09-08）：`npm run check` 131 项、Windows Rust `cargo test` 41 项、`sync-server npm test` 5 项通过；桌面和 Android 前端构建通过，ARM64 与 x86_64 Android Rust/Kotlin/Gradle 编译通过。debug APK 位于仓库根目录 `deploy-artifacts/android-mvp/personal-workbench-aarch64-debug.apk` 和 `personal-workbench-x86_64-debug.apk`。

已在 Android API 36.1 x86_64 模拟器安装 APK，实际验证安全上下文/Web Crypto、单列布局无横向溢出、48px 触控目标、软键盘避让、系统返回键、断网保存健康与四餐、手工消费新增/编辑/确认删除、SQLite tombstone、重启后记录保留、Keystore 测试值读写/重启恢复/删除，以及 preferences 不出现测试值明文。补齐网络状态权限后，真实断网状态正确显示“离线”。测试通过 ADB 和该原生应用自身的 WebView 调试接口执行，没有打开普通 Vite 浏览器页。

线上账户经授权完成密码重置，旧 access/refresh token 撤销验证通过，账户 ID 与业务数据保留并有服务器端备份。Android 模拟器已验证真实账户登录、重启后刷新会话恢复、退出账户；私人同步始终关闭，未上传测试健康数据。v4 服务端已于 2026-09-08 经授权部署，正式 HTTPS 登录、v3 空增量与 v4 配对校验接口验证通过，部署镜像的隔离数据库测试 5 项通过。正式账户仍未绑定私人同步；手机与桌面的生产配对及加密记录往返尚未联调，需用户主动确认历史范围并配对。双端加密同步由本地 HTTP 与三套 SQLite 自动化测试覆盖。详见 [部署记录](private-v4-deployment-2026-09-08.md)。ARM64 APK 已生成，但未在实体手机上安装测试。当前没有密钥轮换、云端重置或硬件后台常驻同步；并发修改使用整条记录的保守冲突策略。

后续可考虑更完整的冲突内容对比、二维码配对、密钥轮换与长期回执压缩；支付通知、银行短信、账单接入、Health Connect 和手机 AI 均不在此版范围内。

参考：[Tauri Android 前置条件](https://v2.tauri.app/start/prerequisites/)、[移动插件](https://v2.tauri.app/develop/plugins/develop-mobile/)、[Android Keystore AES-GCM](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec)。
