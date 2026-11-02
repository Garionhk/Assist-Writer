//! The documents library: `.awd` files in one folder. A document's id is its file name.
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub name: String,
    pub updated_at: String,
    pub size: u64,
}

/// Makes a document name safe as a Windows file name.
pub fn clean_name(name: &str) -> Result<String> {
    let replaced: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { ' ' } else { c })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        bail!("Please enter a document name.");
    }
    Ok(trimmed.chars().take(120).collect())
}

/// Resolves an id to a path in `dir`, refusing anything that could leave the folder.
fn path_in(dir: &Path, id: &str) -> Result<PathBuf> {
    let ok = id.to_lowercase().ends_with(".awd")
        && !id.contains(['/', '\\', ':'])
        && id != ".awd"
        && !id.starts_with("..");
    if !ok {
        bail!("Invalid document id.");
    }
    Ok(dir.join(id))
}

fn item_for(dir: &Path, id: &str) -> Result<LibraryItem> {
    let meta = std::fs::metadata(path_in(dir, id)?)?;
    let updated: chrono::DateTime<chrono::Utc> = meta.modified()?.into();
    Ok(LibraryItem {
        id: id.to_string(),
        name: id[..id.len() - 4].to_string(),
        updated_at: updated.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        size: meta.len(),
    })
}

fn validate(data: &Value) -> Result<()> {
    if data.get("format").and_then(Value::as_str) != Some("assist-writer") {
        bail!("Not an Assist Writer document.");
    }
    Ok(())
}

pub struct Library {
    pub dir: PathBuf,
}

impl Default for Library {
    fn default() -> Self {
        Self { dir: crate::paths::library_dir() }
    }
}

impl Library {
    /// Documents, most recently changed first.
    pub fn list(&self) -> Result<Vec<LibraryItem>> {
        std::fs::create_dir_all(&self.dir)?;
        let mut items: Vec<LibraryItem> = std::fs::read_dir(&self.dir)?
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.to_lowercase().ends_with(".awd"))
            .filter_map(|n| item_for(&self.dir, &n).ok())
            .collect();
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(items)
    }

    pub fn load(&self, id: &str) -> Result<Value> {
        let text = std::fs::read_to_string(path_in(&self.dir, id)?).map_err(|_| anyhow!("Document not found."))?;
        let data: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))?;
        validate(&data)?;
        Ok(data)
    }

    /// Saves a document. With an id it overwrites that document (renaming it if `name`
    /// changed); without one it creates a new document, refusing to overwrite another
    /// document unless `overwrite` is set.
    pub fn save(&self, id: Option<&str>, name: &str, data: &Value, overwrite: bool) -> Result<LibraryItem> {
        validate(data)?;
        std::fs::create_dir_all(&self.dir)?;
        let new_id = format!("{}.awd", clean_name(name)?);
        let target = path_in(&self.dir, &new_id)?;
        if id != Some(new_id.as_str()) && target.exists() && !overwrite {
            bail!("A document named “{}” already exists.", &new_id[..new_id.len() - 4]);
        }
        std::fs::write(&target, serde_json::to_string(data)?)?;
        if let Some(old) = id.filter(|old| *old != new_id) {
            let _ = std::fs::remove_file(path_in(&self.dir, old)?);
        }
        item_for(&self.dir, &new_id)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<LibraryItem> {
        let new_id = format!("{}.awd", clean_name(name)?);
        if new_id != id {
            let exists = path_in(&self.dir, &new_id)?.exists();
            // A case-only rename is the same file on Windows, so allow it.
            if exists && new_id.to_lowercase() != id.to_lowercase() {
                bail!("A document named “{}” already exists.", &new_id[..new_id.len() - 4]);
            }
            std::fs::rename(path_in(&self.dir, id)?, path_in(&self.dir, &new_id)?)?;
        }
        item_for(&self.dir, &new_id)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        match std::fs::remove_file(path_in(&self.dir, id)?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc() -> Value {
        json!({ "format": "assist-writer", "version": 1, "content": { "type": "doc" } })
    }

    #[test]
    fn cleans_names() {
        assert_eq!(clean_name("  My: report?  ").unwrap(), "My report");
        assert_eq!(clean_name("中文 文档.").unwrap(), "中文 文档");
        assert!(clean_name(" ?* ").is_err());
    }

    #[test]
    fn refuses_paths_outside_the_folder() {
        let lib = Library { dir: tempfile::tempdir().unwrap().keep() };
        for bad in ["..\\..\\secret.awd", "../x.awd", "C:\\x.awd", "a/b.awd", "notes.txt", ".awd"] {
            assert!(lib.load(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn save_list_rename_delete() {
        let lib = Library { dir: tempfile::tempdir().unwrap().keep() };
        let a = lib.save(None, "Web test 测试", &doc(), false).unwrap();
        assert_eq!(a.id, "Web test 测试.awd");
        // A second new document with the same name is refused unless overwriting.
        assert!(lib.save(None, "Web test 测试", &doc(), false).is_err());
        assert!(lib.save(None, "Web test 测试", &doc(), true).is_ok());
        // Saving in place under a new name renames.
        let b = lib.save(Some(&a.id), "Renamed", &doc(), false).unwrap();
        assert_eq!(lib.list().unwrap().iter().map(|i| i.id.clone()).collect::<Vec<_>>(), vec![b.id.clone()]);
        let c = lib.rename(&b.id, "renamed").unwrap(); // case-only rename
        assert_eq!(c.name, "renamed");
        assert_eq!(lib.load(&c.id).unwrap()["format"], "assist-writer");
        lib.delete(&c.id).unwrap();
        assert!(lib.list().unwrap().is_empty());
        assert!(lib.save(None, "x", &json!({"format": "other"}), false).is_err());
    }
}
