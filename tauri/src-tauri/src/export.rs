//! Export/import surfaces that don't belong on the analysis engine itself:
//! rendering a Markdown findings report to disk, and zipping/unzipping a
//! whole project (metadata + its `~/.recurse/<name>/` files) for handoff.

use std::io::{Read, Write};

use recurse_agent::report::{self, ReportDoc};
use serde_json::{json, Value};
use tauri::State;
use zip::write::SimpleFileOptions;

use crate::AppState;

/// Render a Markdown findings report for the active binary (capability
/// matches only, for now — `crate::verify`-sourced confirmed/unconfirmed
/// claims are a natural follow-up once a run's `verify::Report` is
/// retained on `AppState`) and write it next to the project, returning
/// both the path and the rendered text so the UI can show it immediately.
#[tauri::command]
pub fn generate_report(state: State<'_, AppState>) -> Result<Value, String> {
    let (binary_label, matches) = {
        let guard = crate::analysis_extra::locked_engine(&state)?;
        let engine = crate::analysis_extra::require_engine(&guard)?;
        let label = engine.path().to_string_lossy().to_string();
        let funcs = engine.functions()?;
        let evidence = crate::analysis_extra::collect_evidence(engine, &funcs);
        let rules = recurse_static::capa::built_in_rules();
        let matches: Vec<(String, String, String)> = rules
            .evaluate(&evidence)
            .into_iter()
            .map(|r| (r.name.clone(), r.namespace.clone(), r.description.clone()))
            .collect();
        (label, matches)
    };

    let mut doc = ReportDoc::new(binary_label.clone());
    let borrowed: Vec<(&str, &str, &str)> = matches
        .iter()
        .map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str()))
        .collect();
    for finding in report::capability_findings(&borrowed) {
        doc.add(finding);
    }
    let markdown = doc.to_markdown();

    let project = state
        .project
        .lock()
        .map_err(|e| format!("project lock poisoned: {e}"))?
        .as_ref()
        .map(|p| p.name.clone());
    let out_path = match project {
        Some(name) => crate::project::project_dir(&name)?.join("report.md"),
        None => {
            let home = crate::db::home_dir()
                .ok_or_else(|| "could not determine home directory".to_string())?;
            home.join(".recurse").join("report.md")
        }
    };
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(&out_path, &markdown)
        .map_err(|e| format!("write {}: {e}", out_path.display()))?;

    Ok(json!({
        "path": out_path.to_string_lossy(),
        "markdown": markdown,
        "finding_count": matches.len(),
    }))
}

/// Zip a project's metadata plus every file under its
/// `~/.recurse/<name>/` directory into `<name>-export.zip` in the user's
/// home directory, for handing the analysis off to someone else or
/// archiving it outside `~/.recurse`.
#[tauri::command]
pub fn export_project(name: String) -> Result<String, String> {
    let project = crate::project::get(&name)?;
    let home =
        crate::db::home_dir().ok_or_else(|| "could not determine home directory".to_string())?;
    let out_path = home.join(format!("{}-export.zip", project.name));

    let file = std::fs::File::create(&out_path)
        .map_err(|e| format!("create {}: {e}", out_path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default();

    let metadata = json!({
        "name": project.name,
        "binary_path": project.binary_path,
        "created_at": project.created_at,
        "updated_at": project.updated_at,
        "exported_at": crate::db::now(),
    });
    zip.start_file("metadata.json", options)
        .map_err(|e| format!("zip metadata.json: {e}"))?;
    zip.write_all(
        serde_json::to_string_pretty(&metadata)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| format!("write metadata.json: {e}"))?;

    for rel in crate::project::list_files(&name)? {
        let content = crate::project::read_file(&name, &rel)?;
        // Zip entry names always use `/`, matching `list_files`'s own
        // documented separator convention.
        zip.start_file(format!("files/{rel}"), options)
            .map_err(|e| format!("zip files/{rel}: {e}"))?;
        zip.write_all(content.as_bytes())
            .map_err(|e| format!("write files/{rel}: {e}"))?;
    }

    zip.finish()
        .map_err(|e| format!("finalize {}: {e}", out_path.display()))?;
    Ok(out_path.to_string_lossy().to_string())
}

/// Import a project previously written by [`export_project`]. Restores
/// the project row (name/binary_path — creating or overwriting an
/// existing project of the same name, same as opening a `create` dialog
/// with that name would) and every file under `files/` in the archive.
/// The referenced binary itself is not part of the archive and must
/// still exist at `binary_path` (or be reopened) for analysis to work.
#[tauri::command]
pub fn import_project(zip_path: String) -> Result<crate::project::Project, String> {
    let file = std::fs::File::open(&zip_path).map_err(|e| format!("open {zip_path}: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read zip {zip_path}: {e}"))?;

    let metadata: Value = {
        let mut entry = zip.by_name("metadata.json").map_err(|_| {
            "archive has no metadata.json — not a Recurse project export".to_string()
        })?;
        let mut text = String::new();
        entry
            .read_to_string(&mut text)
            .map_err(|e| format!("read metadata.json: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("parse metadata.json: {e}"))?
    };
    let name = metadata["name"]
        .as_str()
        .ok_or_else(|| "metadata.json missing \"name\"".to_string())?
        .to_string();
    let binary_path = metadata["binary_path"].as_str().unwrap_or_default();

    let project = crate::project::create(&name, binary_path)?;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("read archive entry {i}: {e}"))?;
        if !entry.is_file() {
            continue;
        }
        let Some(rel) = entry.name().strip_prefix("files/").map(str::to_string) else {
            continue;
        };
        if rel.is_empty() {
            continue;
        }
        let mut content = String::new();
        // A project file that isn't UTF-8 text (LLM-written project code
        // always is) is skipped rather than failing the whole import.
        if entry.read_to_string(&mut content).is_err() {
            continue;
        }
        crate::project::write_file(&name, &rel, &content)?;
    }

    Ok(project)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    #[test]
    fn export_then_import_round_trips_metadata_and_files() {
        crate::test_home!({
            let name = "roundtrip-test-project";
            crate::project::create(name, "C:/demo/sample.exe").expect("create project");
            crate::project::write_file(name, "notes.md", "# findings\nfound the bug")
                .expect("write project file");
            crate::project::write_file(name, "sub/nested.txt", "nested content")
                .expect("write nested project file");

            let zip_path = export_project(name.to_string()).expect("export_project");
            assert!(std::path::Path::new(&zip_path).exists());

            // Remove the original so import demonstrably restores it from
            // the archive, not from the still-present DB row/files.
            crate::project::remove(name).expect("remove original project");
            assert!(crate::project::get(name).is_err());

            let imported = import_project(zip_path).expect("import_project");
            assert_eq!(imported.name, name);
            assert_eq!(imported.binary_path, "C:/demo/sample.exe");

            let notes = crate::project::read_file(name, "notes.md").expect("read notes.md");
            assert_eq!(notes, "# findings\nfound the bug");
            let nested =
                crate::project::read_file(name, "sub/nested.txt").expect("read nested file");
            assert_eq!(nested, "nested content");
        });
    }

    #[test]
    fn import_rejects_an_archive_with_no_metadata() {
        crate::test_home!({
            let home = crate::db::home_dir().expect("test home");
            let bad_zip = home.join("not-a-project.zip");
            let file = std::fs::File::create(&bad_zip).expect("create scratch zip");
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("readme.txt", SimpleFileOptions::default())
                .expect("start entry");
            zip.write_all(b"just some other zip").expect("write entry");
            zip.finish().expect("finish zip");

            let result = import_project(bad_zip.to_string_lossy().to_string());
            let err = match result {
                Ok(_) => panic!("archive without metadata.json must be rejected"),
                Err(e) => e,
            };
            assert!(err.contains("metadata.json"));
        });
    }
}
