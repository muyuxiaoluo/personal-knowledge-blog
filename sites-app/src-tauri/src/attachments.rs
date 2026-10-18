use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tauri::{ipc::InvokeBody, Manager, WebviewWindow};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

const MAX_ORIGINAL_BYTES: usize = 25 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 5 * 1024 * 1024;
const MAX_PIXELS: u64 = 40_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlobVariant {
    Original,
    Preview,
}

impl BlobVariant {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "original" => Ok(Self::Original),
            "preview" => Ok(Self::Preview),
            _ => Err("附件类型无效。".into()),
        }
    }

    fn directory(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Preview => "preview",
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::Original => MAX_ORIGINAL_BYTES,
            Self::Preview => MAX_PREVIEW_BYTES,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ImageInfo {
    mime_type: &'static str,
    width: u32,
    height: u32,
    animated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAttachmentBlob {
    hash: String,
    mime_type: String,
    byte_length: usize,
    width: u32,
    height: u32,
    animated: bool,
}

fn ensure_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("当前窗口无权访问私人附件。".into());
    }
    Ok(())
}

fn attachment_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("attachments"))
        .map_err(|error| format!("无法定位附件目录：{error}"))
}

fn validate_hash(hash: &str) -> Result<(), String> {
    if hash.len() == 64 && hash.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Ok(());
    }
    Err("附件哈希无效。".into())
}

fn blob_path(app: &tauri::AppHandle, variant: BlobVariant, hash: &str) -> Result<PathBuf, String> {
    validate_hash(hash)?;
    Ok(attachment_root(app)?
        .join(variant.directory())
        .join(&hash[..2])
        .join(hash))
}

fn u24_le(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16)
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut offset = 2usize;
    while offset + 4 <= bytes.len() {
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        if offset >= bytes.len() {
            break;
        }
        let marker = bytes[offset];
        offset += 1;
        if matches!(marker, 0xd8 | 0xd9) {
            continue;
        }
        if marker == 0xda {
            break;
        }
        if offset + 2 > bytes.len() {
            break;
        }
        let segment_length = usize::from(u16::from_be_bytes([bytes[offset], bytes[offset + 1]]));
        if segment_length < 2 || offset + segment_length > bytes.len() {
            break;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) && segment_length >= 7
        {
            let height = u32::from(u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]));
            let width = u32::from(u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]));
            return Some((width, height));
        }
        offset += segment_length;
    }
    None
}

fn detect_image(bytes: &[u8]) -> Option<ImageInfo> {
    if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some(ImageInfo {
            mime_type: "image/png",
            width,
            height,
            animated: bytes.windows(4).any(|window| window == b"acTL"),
        });
    }
    if bytes.len() >= 10 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        let width = u32::from(u16::from_le_bytes([bytes[6], bytes[7]]));
        let height = u32::from(u16::from_le_bytes([bytes[8], bytes[9]]));
        return Some(ImageInfo {
            mime_type: "image/gif",
            width,
            height,
            animated: true,
        });
    }
    if bytes.len() >= 30 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        let (width, height, animated) = match &bytes[12..16] {
            b"VP8X" if bytes.len() >= 30 => (
                u24_le(&bytes[24..27]) + 1,
                u24_le(&bytes[27..30]) + 1,
                bytes[20] & 0x02 != 0,
            ),
            b"VP8L" if bytes.len() >= 25 && bytes[20] == 0x2f => {
                let bits = u32::from_le_bytes([bytes[21], bytes[22], bytes[23], bytes[24]]);
                ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, false)
            }
            b"VP8 " if bytes.len() >= 30 && bytes[23..26] == [0x9d, 0x01, 0x2a] => (
                u32::from(u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3fff),
                u32::from(u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3fff),
                false,
            ),
            _ => return None,
        };
        return Some(ImageInfo {
            mime_type: "image/webp",
            width,
            height,
            animated,
        });
    }
    if bytes.len() >= 26 && bytes.starts_with(b"BM") {
        let width = i32::from_le_bytes(bytes[18..22].try_into().ok()?);
        let height = i32::from_le_bytes(bytes[22..26].try_into().ok()?);
        if width <= 0 || height == 0 {
            return None;
        }
        return Some(ImageInfo {
            mime_type: "image/bmp",
            width: width as u32,
            height: height.unsigned_abs(),
            animated: false,
        });
    }
    jpeg_dimensions(bytes).map(|(width, height)| ImageInfo {
        mime_type: "image/jpeg",
        width,
        height,
        animated: false,
    })
}

fn validate_image(bytes: &[u8], variant: BlobVariant) -> Result<ImageInfo, String> {
    if bytes.is_empty() {
        return Err("附件内容为空。".into());
    }
    if bytes.len() > variant.max_bytes() {
        let limit = variant.max_bytes() / (1024 * 1024);
        return Err(format!("图片超过 {limit} MiB 限制。"));
    }
    let info = detect_image(bytes).ok_or_else(|| "图片格式伪造、损坏或不受支持。".to_string())?;
    if info.width == 0
        || info.height == 0
        || u64::from(info.width) * u64::from(info.height) > MAX_PIXELS
    {
        return Err("图片像素尺寸无效或超过 4000 万像素限制。".into());
    }
    Ok(info)
}

#[tauri::command]
pub fn attachment_store_blob(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<StoredAttachmentBlob, String> {
    ensure_main_window(&window)?;
    let variant = request
        .headers()
        .get("x-attachment-variant")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "缺少附件类型。".to_string())
        .and_then(BlobVariant::parse)?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("附件必须使用原始二进制传输。".into()),
    };
    let info = validate_image(bytes, variant)?;
    let hash = hex::encode(Sha256::digest(bytes));
    let target = blob_path(&app, variant, &hash)?;
    if !target.exists() {
        let parent = target
            .parent()
            .ok_or_else(|| "附件目录无效。".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建附件目录：{error}"))?;
        let temporary = parent.join(format!(".{hash}.{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temporary, bytes).map_err(|error| format!("无法写入附件临时文件：{error}"))?;
        if let Err(error) = fs::rename(&temporary, &target) {
            let _ = fs::remove_file(&temporary);
            if !target.exists() {
                return Err(format!("无法启用附件文件：{error}"));
            }
        }
    } else {
        let existing = fs::read(&target).map_err(|error| format!("无法校验已有附件：{error}"))?;
        if Sha256::digest(&existing).as_slice() != Sha256::digest(bytes).as_slice() {
            return Err("附件库中存在哈希不一致的文件，已停止覆盖。".into());
        }
    }

    Ok(StoredAttachmentBlob {
        hash,
        mime_type: info.mime_type.into(),
        byte_length: bytes.len(),
        width: info.width,
        height: info.height,
        animated: info.animated,
    })
}

#[tauri::command]
pub fn attachment_read_blob(
    app: tauri::AppHandle,
    window: WebviewWindow,
    hash: String,
    variant: String,
) -> Result<tauri::ipc::Response, String> {
    ensure_main_window(&window)?;
    let path = blob_path(
        &app,
        BlobVariant::parse(&variant)?,
        &hash.to_ascii_lowercase(),
    )?;
    let bytes = fs::read(path).map_err(|error| format!("附件文件不存在或无法读取：{error}"))?;
    let actual_hash = hex::encode(Sha256::digest(&bytes));
    if actual_hash != hash.to_ascii_lowercase() {
        return Err("附件文件校验失败。".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn attachment_blob_exists(
    app: tauri::AppHandle,
    window: WebviewWindow,
    hash: String,
    variant: String,
) -> Result<bool, String> {
    ensure_main_window(&window)?;
    Ok(blob_path(
        &app,
        BlobVariant::parse(&variant)?,
        &hash.to_ascii_lowercase(),
    )?
    .is_file())
}

#[tauri::command]
pub fn attachment_delete_blob(
    app: tauri::AppHandle,
    window: WebviewWindow,
    hash: String,
    variant: String,
) -> Result<bool, String> {
    ensure_main_window(&window)?;
    let path = blob_path(
        &app,
        BlobVariant::parse(&variant)?,
        &hash.to_ascii_lowercase(),
    )?;
    if !path.is_file() {
        return Ok(false);
    }
    fs::remove_file(&path).map_err(|error| format!("无法清理孤立附件：{error}"))?;
    if let Some(parent) = path.parent() {
        let _ = fs::remove_dir(parent);
    }
    Ok(true)
}

fn blob_endpoint(server_url: &str, hash: &str) -> Result<url::Url, String> {
    validate_hash(hash)?;
    let mut base = url::Url::parse(server_url).map_err(|_| "同步服务器地址无效。".to_string())?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err("同步服务器必须使用 HTTP 或 HTTPS。".into());
    }
    base.set_path(&format!("/v3/blobs/{}", hash.to_ascii_lowercase()));
    base.set_query(None);
    base.set_fragment(None);
    Ok(base)
}

fn validate_access_token(value: &str) -> Result<(), String> {
    if value.len() < 20 || value.len() > 8192 {
        return Err("同步访问令牌无效。".into());
    }
    Ok(())
}

fn attachment_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| format!("无法准备附件同步：{error}"))
}

fn attachment_request_error(action: &str, error: reqwest::Error) -> String {
    if error.is_timeout() {
        return format!("{action}超时，请检查网络或系统代理后重试。");
    }
    if error.is_connect() {
        return format!("{action}无法连接同步服务器，请检查网络、系统代理或安全证书后重试。");
    }
    format!("{action}中断，请检查网络或系统代理后重试。")
}

#[tauri::command]
pub async fn attachment_upload_blob(
    app: tauri::AppHandle,
    window: WebviewWindow,
    server_url: String,
    access_token: String,
    hash: String,
    variant: String,
    mime_type: String,
) -> Result<bool, String> {
    ensure_main_window(&window)?;
    validate_access_token(&access_token)?;
    let variant = BlobVariant::parse(&variant)?;
    let normalized_hash = hash.to_ascii_lowercase();
    let endpoint = blob_endpoint(&server_url, &normalized_hash)?;
    let path = blob_path(&app, variant, &normalized_hash)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("无法读取待上传附件：{error}"))?;
    if metadata.len() > variant.max_bytes() as u64 {
        return Err("待上传附件超过大小限制。".into());
    }
    let client = attachment_http_client()?;
    let exists = client
        .head(endpoint.clone())
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|error| attachment_request_error("检查云端附件", error))?;
    if exists.status().is_success() {
        return Ok(false);
    }
    if exists.status() != reqwest::StatusCode::NOT_FOUND {
        return Err(format!("云端附件检查失败：HTTP {}", exists.status()));
    }
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| format!("无法打开待上传附件：{error}"))?;
    let response = client
        .put(endpoint)
        .bearer_auth(&access_token)
        .header(reqwest::header::CONTENT_TYPE, mime_type)
        .header(reqwest::header::CONTENT_LENGTH, metadata.len())
        .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
        .send()
        .await
        .map_err(|error| attachment_request_error("附件上传", error))?;
    if !response.status().is_success() {
        return Err(format!("附件上传失败：HTTP {}", response.status()));
    }
    Ok(true)
}

#[tauri::command]
pub async fn attachment_download_blob(
    app: tauri::AppHandle,
    window: WebviewWindow,
    server_url: String,
    access_token: String,
    hash: String,
    variant: String,
) -> Result<bool, String> {
    ensure_main_window(&window)?;
    validate_access_token(&access_token)?;
    let variant = BlobVariant::parse(&variant)?;
    let normalized_hash = hash.to_ascii_lowercase();
    let target = blob_path(&app, variant, &normalized_hash)?;
    if target.is_file() {
        return Ok(false);
    }
    let endpoint = blob_endpoint(&server_url, &normalized_hash)?;
    let client = attachment_http_client()?;
    let mut response = client
        .get(endpoint)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|error| attachment_request_error("附件下载", error))?;
    if !response.status().is_success() {
        return Err(format!("附件下载失败：HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > variant.max_bytes() as u64)
    {
        return Err("云端附件超过本机安全限制。".into());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "附件目录无效。".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("无法创建附件下载目录：{error}"))?;
    let temporary = parent.join(format!(
        ".{}.{}.download",
        normalized_hash,
        uuid::Uuid::new_v4()
    ));
    let operation: Result<(), String> = async {
        let mut output = tokio::fs::File::create(&temporary)
            .await
            .map_err(|error| format!("无法创建附件下载临时文件：{error}"))?;
        let mut hasher = Sha256::new();
        let mut total = 0_usize;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("读取附件下载流失败：{error}"))?
        {
            total = total
                .checked_add(chunk.len())
                .ok_or_else(|| "附件下载大小溢出。".to_string())?;
            if total > variant.max_bytes() {
                return Err("云端附件超过本机安全限制。".into());
            }
            hasher.update(&chunk);
            output
                .write_all(&chunk)
                .await
                .map_err(|error| format!("无法写入附件下载流：{error}"))?;
        }
        output
            .sync_all()
            .await
            .map_err(|error| format!("无法安全写入下载附件：{error}"))?;
        drop(output);
        if hex::encode(hasher.finalize()) != normalized_hash {
            return Err("下载附件的 SHA-256 校验失败。".into());
        }
        tokio::fs::rename(&temporary, &target)
            .await
            .map_err(|error| format!("无法启用下载附件：{error}"))?;
        Ok(())
    }
    .await;
    if operation.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    operation?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{detect_image, validate_hash};

    #[test]
    fn rejects_path_like_hashes() {
        assert!(validate_hash("../private").is_err());
        assert!(validate_hash(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn detects_png_dimensions() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&1200_u32.to_be_bytes());
        png.extend_from_slice(&800_u32.to_be_bytes());
        let info = detect_image(&png).expect("PNG should be detected");
        assert_eq!((info.width, info.height), (1200, 800));
        assert_eq!(info.mime_type, "image/png");
    }
}
