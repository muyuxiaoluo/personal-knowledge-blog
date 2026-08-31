use crate::{backup_dir, BackupPath};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read, Seek, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewWindow};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const BACKUP_FORMAT_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_BACKUP_BYTES: u64 = 50 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFileEntry {
    path: String,
    sha256: String,
    bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format: String,
    version: u32,
    created_at: String,
    application: String,
    files: Vec<BackupFileEntry>,
}

fn ensure_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("当前窗口无权创建私人资料备份。".into());
    }
    Ok(())
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("mind-garden.db"))
        .map_err(|error| format!("无法定位资料库：{error}"))
}

fn attachment_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("attachments"))
        .map_err(|error| format!("无法定位附件目录：{error}"))
}

fn timestamp_millis() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| format!("无法生成备份时间：{error}"))
}

fn sqlite_url(path: &Path) -> String {
    format!("sqlite:{}", path.to_string_lossy().replace('\\', "/"))
}

async fn sqlite_integrity_check(path: &Path) -> Result<(), String> {
    let mut connection = SqliteConnection::connect(&sqlite_url(path))
        .await
        .map_err(|error| format!("无法打开备份中的资料库：{error}"))?;
    let result: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut connection)
        .await
        .map_err(|error| format!("无法检查 SQLite 完整性：{error}"))?;
    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(format!("SQLite 完整性检查失败：{result}"))
    }
}

async fn create_sqlite_snapshot(source: &Path, target: &Path) -> Result<(), String> {
    if !source.is_file() {
        return Err("当前资料库不存在，无法创建备份。".into());
    }
    if target.exists() {
        fs::remove_file(target).map_err(|error| format!("无法清理旧临时快照：{error}"))?;
    }
    let mut connection = SqliteConnection::connect(&sqlite_url(source))
        .await
        .map_err(|error| format!("无法打开当前资料库：{error}"))?;
    sqlx::query("VACUUM INTO ?")
        .bind(target.to_string_lossy().as_ref())
        .execute(&mut connection)
        .await
        .map_err(|error| format!("无法生成一致的 SQLite 快照：{error}"))?;
    sqlite_integrity_check(target).await
}

fn hash_reader(mut reader: impl Read) -> Result<(String, u64), String> {
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("无法读取备份内容：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "备份内容大小溢出。".to_string())?;
    }
    Ok((hex::encode(hasher.finalize()), total))
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let file = File::open(path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    hash_reader(file)
}

fn collect_attachment_files(app: &tauri::AppHandle) -> Result<Vec<(String, PathBuf)>, String> {
    let root = attachment_root(app)?;
    let mut files = Vec::new();
    for variant in ["original", "preview"] {
        let variant_dir = root.join(variant);
        if !variant_dir.exists() {
            continue;
        }
        for prefix_entry in fs::read_dir(&variant_dir)
            .map_err(|error| format!("无法读取附件目录：{error}"))?
            .filter_map(Result::ok)
        {
            if !prefix_entry.path().is_dir() {
                continue;
            }
            let prefix = prefix_entry.file_name().to_string_lossy().into_owned();
            if prefix.len() != 2 || !prefix.bytes().all(|value| value.is_ascii_hexdigit()) {
                continue;
            }
            for entry in fs::read_dir(prefix_entry.path())
                .map_err(|error| format!("无法读取附件分片目录：{error}"))?
                .filter_map(Result::ok)
            {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if name.len() != 64 || !name.bytes().all(|value| value.is_ascii_hexdigit()) {
                    continue;
                }
                let (actual, _) = hash_file(&path)?;
                if actual != name {
                    return Err(format!("附件文件校验失败：{name}"));
                }
                files.push((format!("attachments/{variant}/{prefix}/{name}"), path));
            }
        }
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

fn add_file<W: Write + Seek>(
    archive: &mut ZipWriter<W>,
    archive_path: &str,
    source: &Path,
) -> Result<(), String> {
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    archive
        .start_file(archive_path, options)
        .map_err(|error| format!("无法写入备份条目 {archive_path}：{error}"))?;
    let mut file = File::open(source)
        .map_err(|error| format!("无法打开备份源文件 {}：{error}", source.display()))?;
    io::copy(&mut file, archive)
        .map_err(|error| format!("无法复制备份条目 {archive_path}：{error}"))?;
    Ok(())
}

fn verify_archive(path: &Path) -> Result<BackupManifest, String> {
    let file = File::open(path).map_err(|error| format!("无法复核备份包：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("备份包结构无效：{error}"))?;
    let manifest: BackupManifest = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| "备份包缺少清单。".to_string())?;
        if entry.size() > MAX_MANIFEST_BYTES {
            return Err("备份清单异常过大。".into());
        }
        serde_json::from_reader(&mut entry).map_err(|error| format!("备份清单无效：{error}"))?
    };
    if manifest.format != "mind-garden-backup" || manifest.version != BACKUP_FORMAT_VERSION {
        return Err("备份版本不受支持。".into());
    }
    let mut expected_paths = HashSet::from(["manifest.json".to_string()]);
    let mut expected_bytes = 0_u64;
    for expected in &manifest.files {
        if !valid_payload_path(&expected.path)
            || expected.sha256.len() != 64
            || !expected
                .sha256
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
            || !expected_paths.insert(expected.path.clone())
        {
            return Err("备份清单包含无效或重复的文件路径。".into());
        }
        expected_bytes = expected_bytes
            .checked_add(expected.bytes)
            .ok_or_else(|| "备份声明的文件大小溢出。".to_string())?;
        if expected_bytes > MAX_BACKUP_BYTES {
            return Err("备份包展开后异常过大。".into());
        }
    }
    if !manifest
        .files
        .iter()
        .any(|entry| entry.path == "database.sqlite")
    {
        return Err("备份包缺少 SQLite 资料库。".into());
    }
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("无法检查备份条目：{error}"))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "备份包包含路径穿越条目。".to_string())?;
        let name = enclosed.to_string_lossy().replace('\\', "/");
        if !expected_paths.contains(&name) || entry.is_dir() {
            return Err(format!("备份包包含未声明或无效的条目：{name}"));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("备份包不能包含符号链接。".into());
        }
    }
    for expected in &manifest.files {
        let entry = archive
            .by_name(&expected.path)
            .map_err(|_| format!("备份缺少文件：{}", expected.path))?;
        if entry.size() != expected.bytes {
            return Err(format!("备份文件大小不一致：{}", expected.path));
        }
        let (hash, bytes) = hash_reader(entry)?;
        if bytes != expected.bytes || hash != expected.sha256 {
            return Err(format!("备份文件哈希不一致：{}", expected.path));
        }
    }
    Ok(manifest)
}

fn valid_payload_path(value: &str) -> bool {
    if value == "database.sqlite" {
        return true;
    }
    let parts = value.split('/').collect::<Vec<_>>();
    parts.len() == 4
        && parts[0] == "attachments"
        && matches!(parts[1], "original" | "preview")
        && parts[2].len() == 2
        && parts[2].bytes().all(|byte| byte.is_ascii_hexdigit())
        && parts[3].len() == 64
        && parts[3].bytes().all(|byte| byte.is_ascii_hexdigit())
        && parts[3][..2].eq_ignore_ascii_case(parts[2])
}

async fn create_bundle_at(app: &tauri::AppHandle, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "备份目标目录无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建备份目录：{error}"))?;
    if target.exists() {
        return Err("备份文件已经存在，请稍后再试。".into());
    }
    let nonce = uuid::Uuid::new_v4();
    let snapshot = parent.join(format!(".mind-garden-{nonce}.sqlite.tmp"));
    let temporary = parent.join(format!(".mind-garden-{nonce}.mgbak.tmp"));
    let operation = async {
        create_sqlite_snapshot(&database_path(app)?, &snapshot).await?;
        let mut sources = vec![("database.sqlite".to_string(), snapshot.clone())];
        sources.extend(collect_attachment_files(app)?);
        let mut files = Vec::with_capacity(sources.len());
        for (archive_path, source) in &sources {
            let (sha256, bytes) = hash_file(source)?;
            files.push(BackupFileEntry {
                path: archive_path.clone(),
                sha256,
                bytes,
            });
        }
        let manifest = BackupManifest {
            format: "mind-garden-backup".into(),
            version: BACKUP_FORMAT_VERSION,
            created_at: chrono::Utc::now().to_rfc3339(),
            application: "life-strategy-library".into(),
            files,
        };
        let output =
            File::create(&temporary).map_err(|error| format!("无法创建临时备份包：{error}"))?;
        let mut archive = ZipWriter::new(output);
        archive
            .start_file(
                "manifest.json",
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .map_err(|error| format!("无法写入备份清单：{error}"))?;
        archive
            .write_all(
                &serde_json::to_vec_pretty(&manifest)
                    .map_err(|error| format!("无法生成备份清单：{error}"))?,
            )
            .map_err(|error| format!("无法写入备份清单：{error}"))?;
        for (archive_path, source) in &sources {
            add_file(&mut archive, archive_path, source)?;
        }
        let output = archive
            .finish()
            .map_err(|error| format!("无法完成备份包：{error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("无法将备份安全写入磁盘：{error}"))?;
        verify_archive(&temporary)?;
        fs::rename(&temporary, target).map_err(|error| format!("无法启用备份包：{error}"))?;
        Ok(())
    }
    .await;
    let _ = fs::remove_file(&snapshot);
    if operation.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    operation
}

#[tauri::command]
pub async fn create_backup_bundle(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<BackupPath, String> {
    ensure_main_window(&window)?;
    let directory = backup_dir(&app);
    let target = directory.join(format!("mind-garden-{}.mgbak", timestamp_millis()?));
    create_bundle_at(&app, &target).await?;
    Ok(BackupPath {
        path: target.to_string_lossy().into_owned(),
    })
}

fn extract_bundle(source: &Path, target: &Path, manifest: &BackupManifest) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("无法创建恢复临时目录：{error}"))?;
    let file = File::open(source).map_err(|error| format!("无法打开备份包：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("备份包结构无效：{error}"))?;
    for expected in &manifest.files {
        let mut entry = archive
            .by_name(&expected.path)
            .map_err(|_| format!("备份缺少文件：{}", expected.path))?;
        let destination = target.join(Path::new(&expected.path));
        if !destination.starts_with(target) {
            return Err("恢复目标路径越界。".into());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建恢复目录：{error}"))?;
        }
        let mut output = File::create(&destination)
            .map_err(|error| format!("无法创建恢复文件 {}：{error}", expected.path))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| format!("无法提取恢复文件 {}：{error}", expected.path))?;
        output
            .sync_all()
            .map_err(|error| format!("无法安全写入恢复文件 {}：{error}", expected.path))?;
        let (hash, bytes) = hash_file(&destination)?;
        if hash != expected.sha256 || bytes != expected.bytes {
            return Err(format!("提取后的文件校验失败：{}", expected.path));
        }
    }
    Ok(())
}

fn sqlite_header_is_valid(path: &Path) -> Result<bool, String> {
    let mut header = [0_u8; 16];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|error| format!("无法检查 SQLite 文件：{error}"))?;
    Ok(&header == b"SQLite format 3\0")
}

fn install_database_and_attachments(
    app: &tauri::AppHandle,
    staged_database: &Path,
    staged_attachments: Option<&Path>,
) -> Result<(), String> {
    let database = database_path(app)?;
    let attachments = attachment_root(app)?;
    let config_dir = database
        .parent()
        .ok_or_else(|| "资料库目录无效。".to_string())?;
    let nonce = uuid::Uuid::new_v4();
    let old_database = config_dir.join(format!(".mind-garden-{nonce}.db.old"));
    let old_attachments = config_dir.join(format!(".attachments-{nonce}.old"));
    let old_wal = config_dir.join(format!(".mind-garden-{nonce}.wal.old"));
    let old_shm = config_dir.join(format!(".mind-garden-{nonce}.shm.old"));
    let wal = PathBuf::from(format!("{}-wal", database.to_string_lossy()));
    let shm = PathBuf::from(format!("{}-shm", database.to_string_lossy()));

    let mut moved_database = false;
    let mut moved_attachments = false;
    let mut installed_database = false;
    let mut installed_attachments = false;
    let mut moved_wal = false;
    let mut moved_shm = false;

    let operation: Result<(), String> = (|| {
        if database.exists() {
            fs::rename(&database, &old_database)
                .map_err(|error| format!("无法暂存当前资料库：{error}"))?;
            moved_database = true;
        }
        if wal.exists() {
            fs::rename(&wal, &old_wal).map_err(|error| format!("无法暂存当前 WAL：{error}"))?;
            moved_wal = true;
        }
        if shm.exists() {
            fs::rename(&shm, &old_shm)
                .map_err(|error| format!("无法暂存当前共享内存文件：{error}"))?;
            moved_shm = true;
        }
        if let Some(staged) = staged_attachments {
            if attachments.exists() {
                fs::rename(&attachments, &old_attachments)
                    .map_err(|error| format!("无法暂存当前附件库：{error}"))?;
                moved_attachments = true;
            }
            fs::rename(staged, &attachments)
                .map_err(|error| format!("无法启用恢复的附件库：{error}"))?;
            installed_attachments = true;
        }
        fs::rename(staged_database, &database)
            .map_err(|error| format!("无法启用恢复的资料库：{error}"))?;
        installed_database = true;
        Ok(())
    })();

    if let Err(error) = operation {
        if installed_database {
            let _ = fs::remove_file(&database);
        }
        if installed_attachments {
            let _ = fs::remove_dir_all(&attachments);
        }
        if moved_database {
            let _ = fs::rename(&old_database, &database);
        }
        if moved_attachments {
            let _ = fs::rename(&old_attachments, &attachments);
        }
        if moved_wal {
            let _ = fs::rename(&old_wal, &wal);
        }
        if moved_shm {
            let _ = fs::rename(&old_shm, &shm);
        }
        return Err(format!("{error}；当前资料已自动回滚。"));
    }

    if moved_database {
        fs::remove_file(&old_database)
            .map_err(|error| format!("恢复成功，但旧临时资料库清理失败：{error}"))?;
    }
    if moved_attachments {
        fs::remove_dir_all(&old_attachments)
            .map_err(|error| format!("恢复成功，但旧临时附件库清理失败：{error}"))?;
    }
    if moved_wal {
        let _ = fs::remove_file(&old_wal);
    }
    if moved_shm {
        let _ = fs::remove_file(&old_shm);
    }
    Ok(())
}

pub(crate) async fn restore_backup_file(
    app: &tauri::AppHandle,
    source: &Path,
) -> Result<(), String> {
    let directory = backup_dir(app);
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建安全备份目录：{error}"))?;
    let safety = directory.join(format!(
        "mind-garden-before-restore-{}.mgbak",
        timestamp_millis()?
    ));
    create_bundle_at(app, &safety).await?;

    let config_dir = database_path(app)?
        .parent()
        .ok_or_else(|| "资料库目录无效。".to_string())?
        .to_path_buf();
    let staging = config_dir.join(format!(".restore-{}", uuid::Uuid::new_v4()));
    let result: Result<(), String> = async {
        if source.extension().and_then(|value| value.to_str()) == Some("mgbak") {
            let manifest = verify_archive(source)?;
            extract_bundle(source, &staging, &manifest)?;
            let staged_database = staging.join("database.sqlite");
            if !sqlite_header_is_valid(&staged_database)? {
                return Err("备份中的数据库文件头无效。".into());
            }
            sqlite_integrity_check(&staged_database).await?;
            let staged_attachments = staging.join("attachments");
            if !staged_attachments.exists() {
                fs::create_dir_all(&staged_attachments)
                    .map_err(|error| format!("无法准备空附件库：{error}"))?;
            }
            install_database_and_attachments(app, &staged_database, Some(&staged_attachments))
        } else {
            if !sqlite_header_is_valid(source)? {
                return Err("所选文件不是有效的 SQLite 备份。".into());
            }
            sqlite_integrity_check(source).await?;
            fs::create_dir_all(&staging)
                .map_err(|error| format!("无法创建恢复临时目录：{error}"))?;
            let staged_database = staging.join("database.sqlite");
            fs::copy(source, &staged_database)
                .map_err(|error| format!("无法准备旧版恢复文件：{error}"))?;
            install_database_and_attachments(app, &staged_database, None)
        }
    }
    .await;
    if staging.starts_with(&config_dir) {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{hash_reader, BackupFileEntry, BackupManifest, BACKUP_FORMAT_VERSION};

    #[test]
    fn hashes_streamed_backup_content() {
        let (hash, bytes) = hash_reader(&b"mind-garden"[..]).expect("hash should work");
        assert_eq!(bytes, 11);
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn manifest_round_trips() {
        let manifest = BackupManifest {
            format: "mind-garden-backup".into(),
            version: BACKUP_FORMAT_VERSION,
            created_at: "2026-08-30T00:00:00Z".into(),
            application: "life-strategy-library".into(),
            files: vec![BackupFileEntry {
                path: "database.sqlite".into(),
                sha256: "a".repeat(64),
                bytes: 10,
            }],
        };
        let json = serde_json::to_string(&manifest).expect("manifest should serialize");
        let parsed: BackupManifest = serde_json::from_str(&json).expect("manifest should parse");
        assert_eq!(parsed.files[0].path, "database.sqlite");
    }
}
