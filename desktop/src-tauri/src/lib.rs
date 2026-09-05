use serde::{Deserialize, Serialize};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

pub struct SidecarState {
    pub child: Mutex<Option<Child>>,
}

static FORGE_HOME: OnceLock<String> = OnceLock::new();
static SIDECAR_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn forge_home() -> &'static str {
    FORGE_HOME.get_or_init(|| {
        std::env::var("FORGE_HOME").unwrap_or_else(|_| {
            format!("{}/.forge", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
        })
    })
}

fn forge_root() -> &'static str {
    static ROOT: OnceLock<String> = OnceLock::new();
    ROOT.get_or_init(|| {
        std::env::var("FORGE_ROOT").unwrap_or_else(|_| {
            // Dev layout: <repo>/desktop/src-tauri — the repo root is two
            // parents up. Fall back to the manifest dir when the serve script
            // is not found (packaged builds should set FORGE_ROOT explicitly).
            let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
            let repo = manifest.parent().and_then(|p| p.parent());
            match repo {
                Some(dir) if dir.join("src/cli/serve.ts").exists() => dir.to_string_lossy().into_owned(),
                _ => manifest.to_string_lossy().into_owned(),
            }
        })
    })
}

#[derive(Serialize, Deserialize)]
pub struct Handshake {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub port: u16,
    pub host: String,
    pub token: String,
    pub pid: u32,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
}

fn sidecar_child_slot() -> &'static Mutex<Option<Child>> {
    SIDECAR_CHILD.get_or_init(|| Mutex::new(None))
}

fn spawn_sidecar(port: u16) -> Result<u32, String> {
    let serve_script = std::env::var("FORGE_SERVE_SCRIPT")
        .unwrap_or_else(|_| "src/cli/serve.ts".into());
    let root = forge_root();
    let runtime = std::env::var("FORGE_RUNTIME").unwrap_or_else(|_| "pi".into());
    // Delete any stale handshake from a previous run BEFORE spawning. If the
    // serve process fails to boot, wait_for_handshake would otherwise read the
    // old file and inject a dead port/token into the frontend (→ "Load failed").
    let hs_path = std::path::Path::new(forge_home()).join("server.json");
    let _ = std::fs::remove_file(&hs_path);
    let child = Command::new("node")
        .args(["--import", "tsx/esm", &serve_script, "--port", &port.to_string()])
        .current_dir(root)
        .env("FORGE_HOME", forge_home())
        .env("FORGE_RUNTIME", &runtime)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn forge serve: {e}"))?;
    let pid = child.id();
    if let Ok(mut guard) = sidecar_child_slot().lock() {
        *guard = Some(child);
    }
    Ok(pid)
}

fn wait_for_handshake(timeout_ms: u64) -> Result<Handshake, String> {
    let path = std::path::Path::new(forge_home()).join("server.json");
    let start = std::time::Instant::now();
    let mut last_err: Option<String> = None;
    loop {
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(raw) => match serde_json::from_str::<Handshake>(&raw) {
                    Ok(hs) => return Ok(hs),
                    Err(e) => last_err = Some(format!("invalid handshake json: {e}")),
                },
                Err(e) => last_err = Some(format!("read failed: {e}")),
            }
        }
        if start.elapsed().as_millis() > timeout_ms as u128 {
            let child_tracked = sidecar_child_slot()
                .lock()
                .map(|g| g.as_ref().is_some())
                .unwrap_or(false);
            let detail = last_err.unwrap_or_else(|| "server.json was never created".into());
            return Err(format!(
                "handshake timeout after {timeout_ms}ms ({detail}; sidecar child tracked={child_tracked})"
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

fn kill_existing() -> Option<Child> {
    match sidecar_child_slot().lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => None,
    }
}

#[tauri::command]
fn get_handshake() -> Result<Handshake, String> {
    let path = std::path::Path::new(forge_home()).join("server.json");
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read handshake: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("failed to parse handshake: {e}"))
}

#[tauri::command]
fn start_sidecar() -> Result<String, String> {
    if let Some(mut existing) = kill_existing() { let _ = existing.kill(); }
    let pid = spawn_sidecar(0)?;
    Ok(format!("sidecar started (pid={pid})"))
}

#[tauri::command]
fn stop_sidecar() -> Result<String, String> {
    match kill_existing() {
        Some(mut child) => { let _ = child.kill(); Ok("sidecar stopped".into()) }
        None => Ok("no sidecar running".into()),
    }
}

pub fn run() {
    const PORT: u16 = 5300;
    if let Err(e) = spawn_sidecar(PORT) {
        eprintln!("forge-desktop: sidecar failed to start: {e}");
    }

    let token = match wait_for_handshake(10_000) {
        Ok(hs) => hs.token,
        Err(e) => {
            eprintln!("forge-desktop: {e}");
            String::new()
        }
    };

    let init_js = format!(
        "window.__FORGE_CONFIG__ = {{ baseUrl: 'http://127.0.0.1:{}', token: '{}' }};",
        PORT, token
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(sidecar_child_slot())
        .append_invoke_initialization_script(&init_js)
        .invoke_handler(tauri::generate_handler![
            get_handshake, start_sidecar, stop_sidecar,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
