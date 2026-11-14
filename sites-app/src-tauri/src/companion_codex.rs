use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdout, Command},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Evidence {
    pub id: String,
    pub thread_id: String,
    pub title: String,
    pub project_path: String,
    pub occurred_at: String,
    pub updated_at: String,
    pub status: String,
    pub text: String,
    pub limited: bool,
}

pub(crate) struct CodexClient {
    child: Child,
    output: tokio::io::Lines<BufReader<ChildStdout>>,
    sequence: u64,
}

pub(crate) fn executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("WORKBENCH_CODEX_CLI")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
        return Some(path);
    }
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = directory.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        if path.is_file() {
            return Some(path);
        }
    }
    if cfg!(windows) {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Store applications do not necessarily add their CLI to the GUI's PATH.
            // Ask Windows for the registered package instead of requiring directory ACL access.
            if let Ok(output) = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation"])
                .creation_flags(0x08000000).output() {
                for location in String::from_utf8_lossy(&output.stdout).lines() {
                    let path=PathBuf::from(location.trim()).join("app/resources/codex.exe");
                    if path.is_file(){return Some(path);}
                }
            }
        }
        let root = PathBuf::from(std::env::var_os("ProgramFiles")?).join("WindowsApps");
        let mut candidates: Vec<_> = std::fs::read_dir(root)
            .ok()?
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("OpenAI.Codex_")
            })
            .map(|entry| entry.path().join("app/resources/codex.exe"))
            .filter(|p| p.is_file())
            .collect();
        candidates.sort();
        return candidates.pop();
    }
    None
}

impl CodexClient {
    pub async fn connect() -> Result<Self, String> {
        Self::connect_with(None, &[]).await
    }

    pub async fn connect_worker(directory: &std::path::Path) -> Result<Self, String> {
        let mut client = Self::connect_with(Some(directory), &[]).await?;
        let settings = client.worker_extensions(directory).await?;
        if settings.is_empty() {
            return Ok(client);
        }
        // An empty override table does not remove entries from inherited configuration.
        drop(client);
        let mut client = Self::connect_with(Some(directory), &settings).await?;
        if !client.worker_extensions(directory).await?.is_empty() {
            return Err("Codex 仍启用了额外的外部工具，浅羽已停止委托。".into());
        }
        Ok(client)
    }

    async fn worker_extensions(
        &mut self,
        directory: &std::path::Path,
    ) -> Result<Vec<String>, String> {
        let response = self
            .request("config/read", json!({"cwd":directory}))
            .await?;
        let config = response["config"]
            .as_object()
            .ok_or("无法核对 Codex 的外部工具设置。")?;
        let mut overrides = Vec::new();
        for table in ["mcp_servers", "plugins"] {
            if let Some(entries) = config.get(table).and_then(Value::as_object) {
                let mut disabled = Vec::new();
                for (name, setting) in entries {
                    if setting["enabled"].as_bool() != Some(false) {
                        let key = serde_json::to_string(name).map_err(|e| e.to_string())?;
                        disabled.push(format!("{key}={{enabled=false}}"));
                    }
                }
                if !disabled.is_empty() {
                    overrides.push(format!("{table}={{{}}}", disabled.join(",")));
                }
            }
        }
        Ok(overrides)
    }

    async fn connect_with(
        directory: Option<&std::path::Path>,
        overrides: &[String],
    ) -> Result<Self, String> {
        let path = executable().ok_or("未找到 Codex。请先安装或启动 Codex 桌面版。")?;
        let mut command = Command::new(path);
        if let Some(directory) = directory {
            command.current_dir(directory);
            // The legacy Windows implementations cannot enforce this restricted-read profile.
            #[cfg(windows)]
            command.args(["-c", "windows.sandbox=mxc"]);
            // Delegated turns must not inherit user-defined plugins or command hooks.
            command.args([
                "-c",
                r#"default_permissions="asaba-local-worker""#,
                "-c",
                r#"permissions.asaba-local-worker={extends=":workspace", filesystem={":root"="deny", ":minimal"="read", ":tmpdir"="deny", ":slash_tmp"="deny"}, network={enabled=false}}"#,
                "-c",
                "features.hooks=false",
                "-c",
                "features.apps=false",
                "-c",
                "features.plugins=false",
                "-c",
                "features.multi_agent=false",
            ]);
            for setting in overrides {
                command.arg("-c").arg(setting);
            }
        }
        command
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法连接 Codex：{e}"))?;
        let output = BufReader::new(child.stdout.take().ok_or("无法读取 Codex 输出")?).lines();
        let mut client = Self {
            child,
            output,
            sequence: 0,
        };
        client.request("initialize", json!({"clientInfo":{"name":"personal_workbench_companion","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
        client.write(json!({"method":"initialized"})).await?;
        Ok(client)
    }
    pub async fn write(&mut self, value: Value) -> Result<(), String> {
        let bytes = format!("{value}\n");
        self.child
            .stdin
            .as_mut()
            .ok_or("Codex 连接已关闭")?
            .write_all(bytes.as_bytes())
            .await
            .map_err(|e| format!("Codex 连接不可写：{e}"))
    }
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.sequence += 1;
        let id = self.sequence;
        self.write(json!({"id":id,"method":method,"params":params}))
            .await?;
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let frame = self.frame().await?;
                if frame.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if let Some(error) = frame.get("error") {
                    return Err(format!(
                        "Codex 读取失败：{}",
                        error["message"].as_str().unwrap_or("接口不兼容")
                    ));
                }
                return Ok(frame["result"].clone());
            }
        })
        .await
        .map_err(|_| "读取 Codex 超时，稍后可重新连接。".to_string())?
    }

    pub async fn frame(&mut self) -> Result<Value, String> {
        loop {
            let line = self
                .output
                .next_line()
                .await
                .map_err(|e| format!("读取 Codex 失败：{e}"))?
                .ok_or("Codex 连接已结束。")?;
            if line.len() > 8 * 1024 * 1024 {
                return Err("Codex 单条记录过大，已停止读取。".into());
            }
            if let Ok(frame) = serde_json::from_str(&line) {
                return Ok(frame);
            }
        }
    }
}

fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").to_string()
}
fn date(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    value
        .as_i64()
        .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
        .map(|date| date.to_rfc3339())
        .unwrap_or_default()
}
pub(crate) fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}
pub(crate) fn excerpt(text: &str, limit: usize) -> String {
    let chars: Vec<_> = text.chars().collect();
    if chars.len() <= limit {
        return text.to_string();
    }
    let head = limit / 3;
    format!(
        "{}\n…中间记录已省略…\n{}",
        chars[..head].iter().collect::<String>(),
        chars[chars.len() - (limit - head)..]
            .iter()
            .collect::<String>()
    )
}

fn turn_time(turn: &Value) -> String {
    let completed = date(&turn["completedAt"]);
    if !completed.is_empty() {
        return completed;
    }
    let latest = turn["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item["completedAtMs"]
                .as_i64()
                .or_else(|| item["startedAtMs"].as_i64())
        })
        .max();
    if let Some(time) = latest.and_then(chrono::DateTime::from_timestamp_millis) {
        return time.to_rfc3339();
    }
    date(&turn["startedAt"])
}
pub(crate) fn turn_day(turn: &Value) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(&turn_time(turn))
        .ok()
        .map(|date| {
            date.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
}

pub(crate) fn evidence(thread: &Value, turn: &Value, day: &str) -> Option<Evidence> {
    let occurred_at = turn_time(turn);
    let local_day = chrono::DateTime::parse_from_rfc3339(&occurred_at)
        .ok()?
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d")
        .to_string();
    if local_day != day {
        return None;
    }
    let mut parts = Vec::new();
    for item in turn["items"].as_array().into_iter().flatten() {
        match item["type"].as_str().unwrap_or("") {
            "userMessage" => {
                let text = item["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                parts.push(format!("用户提到：{}", clip(&text, 1000)));
            }
            "agentMessage" => parts.push(format!(
                "助手答复（陈述未独立核验）：{}",
                clip(item["text"].as_str().unwrap_or(""), 1800)
            )),
            "commandExecution" => parts.push(format!(
                "工具执行：{}\n退出码：{}\n输出摘录：{}",
                clip(item["command"].as_str().unwrap_or(""), 300),
                item["exitCode"],
                clip(item["aggregatedOutput"].as_str().unwrap_or(""), 850)
            )),
            "fileChange" => {
                let paths = item["changes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|change| change["path"].as_str())
                    .take(20)
                    .collect::<Vec<_>>()
                    .join("、");
                if !paths.is_empty() {
                    parts.push(format!(
                        "文件操作记录（{}）：{paths}",
                        item["status"].as_str().unwrap_or("未知状态")
                    ));
                }
            }
            "mcpToolCall" => {
                let output = item["result"]["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                parts.push(format!(
                    "工具调用：{}.{}（{}）\n返回摘录：{}",
                    string(item, "server"),
                    string(item, "tool"),
                    string(item, "status"),
                    excerpt(&output, 650)
                ));
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        return None;
    }
    let text = parts.join("\n\n");
    Some(Evidence {
        id: format!("codex:{}:{}", string(thread, "id"), string(turn, "id")),
        thread_id: string(thread, "id"),
        title: thread["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| thread["preview"].as_str().unwrap_or("Codex 会话"))
            .chars()
            .take(120)
            .collect(),
        project_path: string(thread, "cwd"),
        occurred_at,
        updated_at: date(&thread["updatedAt"]),
        status: string(turn, "status"),
        limited: turn["itemsView"].as_str() == Some("summary") || text.chars().count() > 6000,
        text: excerpt(&text, 6000),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evidence_preserves_claims_and_execution_separately() {
        let day = "2026-11-09";
        let thread = json!({"id":"t","cwd":"D:/p","name":"a","updatedAt":1794182400});
        let turn = json!({"id":"u","startedAt":"2026-11-09T09:00:00+08:00","status":"completed","items":[{"type":"agentMessage","text":"全部完成"},{"type":"commandExecution","command":"test","exitCode":1,"aggregatedOutput":"failed"},{"type":"reasoning","text":"hidden"}]});
        let record = evidence(&thread, &turn, day).unwrap();
        assert!(record.text.contains("未独立核验"));
        assert!(record.text.contains("退出码：1"));
        assert!(!record.text.contains("hidden"));
        assert!(evidence(&thread, &turn, "2026-11-10").is_none());
    }
    #[test]
    fn cross_day_work_is_grouped_by_the_latest_recorded_activity() {
        let thread = json!({"id":"t","name":"night work"});
        let turn = json!({"id":"u","startedAt":"2026-11-08T23:00:00+08:00","completedAt":"2026-11-09T01:00:00+08:00","status":"completed","items":[{"type":"agentMessage","text":"result"}]});
        let local_day = chrono::DateTime::parse_from_rfc3339("2026-11-09T01:00:00+08:00")
            .unwrap()
            .with_timezone(&chrono::Local)
            .format("%Y-%m-%d")
            .to_string();
        assert!(evidence(&thread, &turn, &local_day).is_some());
    }
    #[test]
    fn long_records_keep_the_late_execution_result() {
        let text = format!("request{}final failed", "x".repeat(9000));
        let short = excerpt(&text, 1800);
        assert!(short.starts_with("request"));
        assert!(short.ends_with("final failed"));
        assert!(short.contains("已省略"));
    }
}
