use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

fn main() {
    println!("cargo:rerun-if-changed=../ui/src");
    println!("cargo:rerun-if-changed=../ui/index.html");
    println!("cargo:rerun-if-changed=../ui/package.json");

    // `cargo run` does not execute tauri `beforeBuildCommand`.
    // Rebuild frontend when dist is missing or older than UI sources.
    if should_build_ui() {
        run_ui_build();
    }

    ensure_workbench_out_link();

    tauri_build::build();
}

fn should_build_ui() -> bool {
    let dist_index = Path::new("../ui/dist/index.html");
    let dist_time = modified_time(dist_index);
    let source_time = newest_ui_source_mtime();

    match (dist_time, source_time) {
        (Some(dist), Some(src)) => src > dist,
        (None, Some(_)) => true,
        _ => true,
    }
}

fn newest_ui_source_mtime() -> Option<SystemTime> {
    let mut newest = modified_time(Path::new("../ui/index.html"));
    newest = max_time(newest, modified_time(Path::new("../ui/package.json")));
    newest = max_time(newest, newest_tree_time(Path::new("../ui/src")));
    newest
}

fn newest_tree_time(root: &Path) -> Option<SystemTime> {
    let mut newest: Option<SystemTime> = None;
    let mut pending: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(path) = pending.pop() {
        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };

        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                pending.push(entry_path);
            } else {
                newest = max_time(newest, modified_time(&entry_path));
            }
        }
    }

    newest
}

fn modified_time(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok().and_then(|metadata| metadata.modified().ok())
}

fn max_time(a: Option<SystemTime>, b: Option<SystemTime>) -> Option<SystemTime> {
    match (a, b) {
        (Some(left), Some(right)) => Some(if right > left { right } else { left }),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn run_ui_build() {
    let status = Command::new("npm")
        .args(["--prefix", "../ui", "run", "build"])
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .expect("failed to spawn npm build for tauri UI");

    assert!(
        status.success(),
        "UI build failed while preparing Tauri assets. Run `npm --prefix apps/tauri/ui run build` and retry."
    );
}

fn ensure_workbench_out_link() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    if manifest_dir.as_os_str().is_empty() {
        return;
    }

    let repo_out = manifest_dir.join("../../..").join("out");
    if !repo_out.exists() {
        return;
    }

    let ui_root = manifest_dir.join("../ui");
    let ui_dist = ui_root.join("dist");
    let _ = ensure_link(ui_root.join("out"), &repo_out);
    let _ = ensure_link(ui_dist.join("out"), &repo_out);
}

fn ensure_link(link_path: PathBuf, target: &Path) -> std::io::Result<()> {
    if let Ok(existing) = fs::symlink_metadata(&link_path) {
        if existing.file_type().is_symlink() {
            if let Ok(current_target) = fs::read_link(&link_path) {
                if current_target == target {
                    return Ok(());
                }
            }
        }

        if existing.file_type().is_dir() {
            fs::remove_dir_all(&link_path)?;
        } else {
            fs::remove_file(&link_path)?;
        }
    }

    if let Some(parent) = link_path.parent() {
        fs::create_dir_all(parent)?;
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, &link_path)?;
    }

    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(target, &link_path)?;
    }

    Ok(())
}
