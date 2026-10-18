use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

const API: &str = "http://127.0.0.1:11434";

async fn configured_models(local_data: &Path) -> Result<Option<PathBuf>, String> {
    use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
    let directory = local_data.join("Ollama");
    let database = directory.join("db.sqlite");
    let configured: Option<String> = if database.is_file() {
        let options = SqliteConnectOptions::new()
            .filename(&database)
            .read_only(true)
            .busy_timeout(Duration::from_secs(1));
        let mut connection = SqliteConnection::connect_with(&options)
            .await
            .map_err(|error| {
                format!("无法读取 Ollama 的模型目录设置：{error}。原始记录已保存。")
            })?;
        sqlx::query_scalar("SELECT models FROM settings WHERE id = 1")
            .fetch_optional(&mut connection)
            .await
            .map_err(|error| format!("无法读取 Ollama 的模型目录设置：{error}。原始记录已保存。"))?
    } else if directory.join("config.json").is_file() {
        let bytes = std::fs::read(directory.join("config.json"))
            .map_err(|error| format!("无法读取 Ollama 设置：{error}"))?;
        let config: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("无法读取 Ollama 设置：{error}"))?;
        config["models"].as_str().map(str::to_owned)
    } else {
        None
    };
    Ok(configured
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from))
}

#[derive(Default)]
struct ProcessState {
    child: Option<Child>,
    stopping: bool,
}

#[derive(Default)]
pub(crate) struct OllamaRuntime {
    startup: tokio::sync::Mutex<()>,
    process: Mutex<ProcessState>,
}

async fn ready(client: &reqwest::Client) -> bool {
    let Ok(response) = client.get(format!("{API}/api/version")).send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response
        .json::<serde_json::Value>()
        .await
        .ok()
        .is_some_and(|value| {
            value["version"]
                .as_str()
                .is_some_and(|version| !version.is_empty())
        })
}

fn executable() -> Option<PathBuf> {
    let installed = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("Programs/Ollama/ollama.exe"));
    installed.filter(|path| path.is_file()).or_else(|| {
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|path| path.join("ollama.exe"))
                .find(|path| path.is_file())
        })
    })
}

impl OllamaRuntime {
    pub(crate) async fn ensure_ready(&self) -> Result<(), String> {
        let _startup = self.startup.lock().await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|error| format!("无法检查 Ollama 服务：{error}"))?;
        // An existing Ollama service belongs to the user, not to the workbench.
        if ready(&client).await {
            return Ok(());
        }
        // The desktop app can override OLLAMA_MODELS in its saved settings.
        // Reuse that directory rather than accidentally starting with an empty model library.
        let models = if let Some(local_data) = std::env::var_os("LOCALAPPDATA") {
            configured_models(&PathBuf::from(local_data)).await?
        } else {
            None
        };
        {
            let mut state = self.process.lock().map_err(|_| "Ollama 启动状态不可用")?;
            if state.stopping {
                return Err("工作台正在退出，未启动 Ollama。".into());
            }
            if let Some(child) = &mut state.child {
                if child
                    .try_wait()
                    .map_err(|error| format!("无法检查 Ollama 进程：{error}"))?
                    .is_some()
                {
                    state.child = None;
                }
            }
            if state.child.is_none() {
                let path = executable().ok_or("没有找到已安装的 Ollama。请先安装 Ollama；自定义安装位置需加入 PATH。原始记录已保存。")?;
                use std::os::windows::process::CommandExt;
                let mut command = Command::new(path);
                command
                    .arg("serve")
                    // Bind only to this machine, matching the observer's fixed local endpoint.
                    .env("OLLAMA_HOST", "127.0.0.1:11434")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
                if let Some(models) = &models {
                    command.env("OLLAMA_MODELS", models);
                }
                let child = command
                    .spawn()
                    .map_err(|error| format!("Ollama 后台启动失败：{error}。原始记录已保存。"))?;
                state.child = Some(child);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if ready(&client).await {
                return Ok(());
            }
            {
                let mut state = self.process.lock().map_err(|_| "Ollama 启动状态不可用")?;
                if state.stopping {
                    return Err("工作台正在退出。".into());
                }
                if let Some(child) = &mut state.child {
                    if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                        state.child = None;
                        return Err(format!("Ollama 后台进程已退出（{status}）。请检查 Ollama 服务或端口占用；原始记录已保存。"));
                    }
                }
            }
            if Instant::now() >= deadline {
                return Err(
                    "Ollama 已在后台启动，但服务尚未就绪；稍后再次观察即可重试。原始记录已保存。"
                        .into(),
                );
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    pub(crate) fn stop(&self) {
        if let Ok(mut state) = self.process.lock() {
            state.stopping = true;
            // Never terminate a service started outside this workbench.
            if let Some(mut child) = state.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_service_uses_desktop_model_directory() {
        tauri::async_runtime::block_on(async {
            use sqlx::{Connection, SqliteConnection};
            let root =
                std::env::temp_dir().join(format!("ollama-settings-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(root.join("Ollama")).unwrap();
            let custom = root.join("models on another drive");
            let options = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(root.join("Ollama/db.sqlite"))
                .create_if_missing(true);
            let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
            sqlx::query("CREATE TABLE settings (id INTEGER PRIMARY KEY, models TEXT)")
                .execute(&mut connection)
                .await
                .unwrap();
            sqlx::query("INSERT INTO settings VALUES (1, ?)")
                .bind(custom.to_string_lossy().as_ref())
                .execute(&mut connection)
                .await
                .unwrap();
            connection.close().await.unwrap();
            assert_eq!(configured_models(&root).await.unwrap(), Some(custom));
            std::fs::remove_dir_all(&root).unwrap();
        });
    }

    #[test]
    #[ignore = "requires an installed Ollama; starts a local background service"]
    fn installed_service_starts_and_is_reused() {
        tauri::async_runtime::block_on(async {
            let runtime = OllamaRuntime::default();
            struct Cleanup<'a>(&'a OllamaRuntime);
            impl Drop for Cleanup<'_> {
                fn drop(&mut self) {
                    self.0.stop();
                }
            }
            let _cleanup = Cleanup(&runtime);
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(90))
                .build()
                .unwrap();
            let already_running = ready(&client).await;
            runtime.ensure_ready().await.unwrap();
            let first_pid = runtime
                .process
                .lock()
                .unwrap()
                .child
                .as_ref()
                .map(Child::id);
            if !already_running {
                assert!(
                    first_pid.is_some(),
                    "a cold start must own its background process"
                );
            }
            runtime.ensure_ready().await.unwrap();
            assert_eq!(
                first_pid,
                runtime
                    .process
                    .lock()
                    .unwrap()
                    .child
                    .as_ref()
                    .map(Child::id)
            );
            let response = client
                .post(format!("{API}/api/generate"))
                .json(&serde_json::json!({
                    "model": "qwen3.5:4b-q4_K_M", "prompt": "只回复 OK", "stream": false,
                    "think": false, "keep_alive": 0, "options": {"num_predict": 8, "num_ctx": 1024}
                }))
                .send()
                .await
                .unwrap();
            assert!(
                response.status().is_success(),
                "model request failed: {}",
                response.text().await.unwrap()
            );
            println!("Ollama ready; workbench-owned process: {first_pid:?}");
            runtime.stop();
            if first_pid.is_some() {
                assert!(
                    !ready(&client).await,
                    "the workbench-owned service must stop"
                );
            } else {
                assert!(
                    ready(&client).await,
                    "a pre-existing service must remain running"
                );
            }
        });
    }
}
