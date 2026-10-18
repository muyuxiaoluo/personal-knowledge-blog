use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Instant, UNIX_EPOCH},
};

const MAX_FILES: usize = 1500;
const MAX_TEXT_BYTES: u64 = 128 * 1024;
const MAX_TOTAL_TEXT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct FileSnapshot {
    pub stamp: String,
    pub text: Option<String>,
}
pub(crate) type Snapshot = BTreeMap<String, FileSnapshot>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileChange {
    pub path: String,
    pub kind: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub excerpt_limited: bool,
}

pub(crate) struct Scan {
    pub files: Snapshot,
    pub notes: Vec<String>,
    pub complete: bool,
}

fn excluded(name: &str, directory: bool) -> bool {
    let name = name.to_lowercase();
    if directory {
        return matches!(
            name.as_str(),
            ".git"
                | "node_modules"
                | "target"
                | ".venv"
                | "venv"
                | "dist"
                | "desktop-dist"
                | "build"
                | ".idea"
                | ".next"
                | "work-observer"
        );
    }
    name.starts_with('.')
        || name.contains("secret")
        || name.contains("credential")
        || name.contains("password")
        || matches!(
            Path::new(&name).extension().and_then(|v| v.to_str()),
            Some("pem" | "key" | "pfx" | "db" | "sqlite" | "sqlite3" | "db-wal" | "db-shm")
        )
}

fn is_text(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|v| v.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some(
            "txt"
                | "md"
                | "tex"
                | "bib"
                | "log"
                | "csv"
                | "json"
                | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "mjs"
                | "cjs"
                | "rs"
                | "py"
                | "html"
                | "css"
                | "scss"
                | "toml"
                | "yaml"
                | "yml"
                | "xml"
        )
    )
}

pub(crate) fn scan(roots: &[String]) -> Scan {
    let mut scan = Scan {
        files: Snapshot::new(),
        notes: Vec::new(),
        complete: true,
    };
    let start = Instant::now();
    let mut total_text = 0;
    for root in roots {
        let root = PathBuf::from(root);
        let mut pending = vec![(root.clone(), 0)];
        while let Some((directory, depth)) = pending.pop() {
            if scan.files.len() >= MAX_FILES || start.elapsed().as_secs() >= 3 {
                scan.complete = false;
                break;
            }
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(_) => {
                    scan.complete = false;
                    continue;
                }
            };
            for entry in entries {
                if start.elapsed().as_secs() >= 3 {
                    scan.complete = false;
                    break;
                }
                let Ok(entry) = entry else {
                    scan.complete = false;
                    continue;
                };
                let path = entry.path();
                let Ok(metadata) = fs::symlink_metadata(&path) else {
                    scan.complete = false;
                    continue;
                };
                // Symlinks and Windows junctions may lead outside the selected scope.
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        continue;
                    }
                }
                if metadata.file_type().is_symlink()
                    || excluded(&entry.file_name().to_string_lossy(), metadata.is_dir())
                {
                    continue;
                }
                if metadata.is_dir() {
                    if depth < 8 {
                        pending.push((path, depth + 1));
                    } else {
                        scan.complete = false;
                    }
                    continue;
                }
                if !metadata.is_file() {
                    continue;
                }
                if scan.files.len() >= MAX_FILES {
                    scan.complete = false;
                    break;
                }
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|v| v.as_nanos())
                    .unwrap_or_default();
                let stamp = format!("{}:{modified}", metadata.len());
                let text = if is_text(&path)
                    && metadata.len() <= MAX_TEXT_BYTES
                    && total_text + metadata.len() as usize <= MAX_TOTAL_TEXT_BYTES
                {
                    let mut bytes = Vec::new();
                    if let Ok(mut file) = fs::File::open(&path) {
                        if file
                            .by_ref()
                            .take(MAX_TEXT_BYTES + 1)
                            .read_to_end(&mut bytes)
                            .is_ok()
                            && bytes.len() as u64 <= MAX_TEXT_BYTES
                        {
                            total_text += bytes.len();
                            if file.metadata().ok().is_none_or(|now| {
                                now.len() != metadata.len()
                                    || now.modified().ok() != metadata.modified().ok()
                            }) {
                                scan.complete = false;
                                continue;
                            }
                            String::from_utf8(bytes)
                                .ok()
                                .filter(|text| !text.contains('\0'))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };
                scan.files.insert(
                    path.to_string_lossy().into_owned(),
                    FileSnapshot { stamp, text },
                );
            }
        }
    }
    if !scan.complete {
        scan.notes.push("文件夹部分内容未能读取，或超过 1500 个文件、8 层目录、3 秒扫描范围；未据此判断文件删除。".into());
    }
    if total_text >= MAX_TOTAL_TEXT_BYTES {
        scan.notes
            .push("本次文本读取达到 8 MB；其余文件仅记录文件变化。".into());
    }
    scan
}

fn clip(text: &str, limit: usize) -> (String, bool) {
    (
        text.chars().take(limit).collect(),
        text.chars().count() > limit,
    )
}

pub(crate) fn changed_excerpt(before: &str, after: &str) -> (String, String, bool) {
    let left: Vec<&str> = before.lines().collect();
    let right: Vec<&str> = after.lines().collect();
    let prefix = left.iter().zip(&right).take_while(|(a, b)| a == b).count();
    let suffix = left[prefix..]
        .iter()
        .rev()
        .zip(right[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let (left, limited_left) = clip(&left[prefix..left.len() - suffix].join("\n"), 1200);
    let (right, limited_right) = clip(&right[prefix..right.len() - suffix].join("\n"), 1200);
    (left, right, limited_left || limited_right)
}

pub(crate) fn changes(before: &Snapshot, after: &Snapshot, complete: bool) -> Vec<FileChange> {
    let mut result = Vec::new();
    for (path, file) in after {
        if let Some(old) = before.get(path) {
            if old.stamp == file.stamp
                && (old.text.is_none() || file.text.is_none() || old.text == file.text)
            {
                continue;
            }
            let (left, right, limited) = match (&old.text, &file.text) {
                (Some(left), Some(right)) => {
                    let (a, b, limited) = changed_excerpt(left, right);
                    (Some(a), Some(b), limited)
                }
                _ => (None, None, false),
            };
            result.push(FileChange {
                path: path.clone(),
                kind: "modified".into(),
                before: left,
                after: right,
                excerpt_limited: limited,
            });
        } else {
            let (after, limited) = file
                .text
                .as_deref()
                .map(|v| clip(v, 1200))
                .map(|(text, limited)| (Some(text), limited))
                .unwrap_or((None, false));
            result.push(FileChange {
                path: path.clone(),
                kind: "created".into(),
                before: None,
                after,
                excerpt_limited: limited,
            });
        }
    }
    if complete {
        for path in before.keys().filter(|path| !after.contains_key(*path)) {
            result.push(FileChange {
                path: path.clone(),
                kind: "deleted".into(),
                before: None,
                after: None,
                excerpt_limited: false,
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excerpt_keeps_real_edits_without_unchanged_context() {
        assert_eq!(
            changed_excerpt("标题\n旧段落\n结尾", "标题\n新段落\n结尾"),
            ("旧段落".into(), "新段落".into(), false)
        );
        assert_eq!(
            changed_excerpt("a\nb", "a\nx\nb"),
            ("".into(), "x".into(), false)
        );
    }
    #[test]
    fn partial_scan_never_claims_deletion_and_binary_change_has_no_text() {
        let before = BTreeMap::from([(
            "a.docx".into(),
            FileSnapshot {
                stamp: "1".into(),
                text: None,
            },
        )]);
        assert!(changes(&before, &Snapshot::new(), false).is_empty());
        assert_eq!(changes(&before, &Snapshot::new(), true)[0].kind, "deleted");
        let after = BTreeMap::from([(
            "a.docx".into(),
            FileSnapshot {
                stamp: "2".into(),
                text: None,
            },
        )]);
        assert!(changes(&before, &after, true)[0].after.is_none());
    }
    #[test]
    fn ignores_generated_and_secret_material() {
        assert!(excluded("node_modules", true));
        assert!(excluded(".env", false));
        assert!(excluded("private.key", false));
        assert!(!excluded("methods.tex", false));
    }

    #[test]
    fn scans_real_files_and_reads_only_the_selected_scope() {
        let root =
            std::env::temp_dir().join(format!("work-observer-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("methods.tex"), "标题\n第一版\n结尾").unwrap();
        fs::write(root.join(".env"), "secret").unwrap();
        fs::write(root.join("node_modules/generated.txt"), "generated").unwrap();
        let roots = vec![root.to_string_lossy().into_owned()];
        let before = scan(&roots);
        assert!(before.complete);
        assert_eq!(before.files.len(), 1);
        fs::write(root.join("methods.tex"), "标题\n新的方法段落\n结尾").unwrap();
        fs::write(root.join("results.txt"), "结果待验证").unwrap();
        let after = scan(&roots);
        let updates = changes(&before.files, &after.files, after.complete);
        assert_eq!(updates.len(), 2);
        let update = updates.iter().find(|file| file.kind == "modified").unwrap();
        assert_eq!(update.before.as_deref(), Some("第一版"));
        assert_eq!(update.after.as_deref(), Some("新的方法段落"));
        fs::remove_file(root.join("methods.tex")).unwrap();
        let last = scan(&roots);
        assert_eq!(
            changes(&after.files, &last.files, last.complete)[0].kind,
            "deleted"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
