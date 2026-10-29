use std::path::{Path, PathBuf};

const FILES: [&str; 6] = [
    "LICENSE",
    "docker-compose.yml",
    "package.json",
    "bun.lock",
    "tsconfig.base.json",
    "bunfig.toml",
];
const DIRECTORIES: [&str; 8] = [
    "server", "app", "worker", "shared", "toolkit", "examples", "scripts", "patches",
];

pub fn source_root() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .ok()?;
    source
        .join("server/src/local-runtime.ts")
        .is_file()
        .then_some(source)
}

pub fn copy_source(source: &Path, target: &Path) -> Result<(), String> {
    let source = source.canonicalize().map_err(|error| error.to_string())?;
    refuse_symlink(target)?;
    let target = resolved_destination(target)?;
    if source == target {
        return Ok(());
    }
    if target.starts_with(&source) || source.starts_with(&target) {
        return Err("Choose a deployment folder outside the Free-bot source tree.".into());
    }
    std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    for name in FILES {
        refuse_symlink(&target.join(name))?;
        std::fs::copy(source.join(name), target.join(name))
            .map_err(|error| format!("Could not copy {name}: {error}"))?;
    }
    for name in DIRECTORIES {
        let directory = source.join(name);
        if directory.is_dir() {
            copy_directory(&directory, &target.join(name))?;
        }
    }
    Ok(())
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    refuse_symlink(target)?;
    std::fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.')
            || matches!(
                name.as_ref(),
                "node_modules" | "dist" | "target" | "Agents" | "Data" | "Transfers"
            )
        {
            continue;
        }
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        let destination = target.join(entry.file_name());
        refuse_symlink(&destination)?;
        if kind.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn refuse_symlink(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "The deployment destination must not contain symbolic links: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn resolved_destination(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path)
    };
    let mut ancestor = absolute.clone();
    let mut remainder = Vec::new();
    while !ancestor.exists() {
        let name = ancestor
            .file_name()
            .ok_or("The deployment path cannot be resolved.")?
            .to_owned();
        remainder.push(name);
        ancestor = ancestor
            .parent()
            .ok_or("The deployment path has no existing parent.")?
            .to_path_buf();
    }
    let mut destination = ancestor.canonicalize().map_err(|error| error.to_string())?;
    for name in remainder.into_iter().rev() {
        destination.push(name);
    }
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    #[test]
    fn local_source_keeps_runtime_files_and_excludes_credentials_and_user_state() {
        let fixture = temp_root("free-bot-local-deployment");
        let source = fixture.join("source");
        let target = fixture.join("deployment");
        std::fs::create_dir_all(&source).unwrap();
        for name in FILES {
            std::fs::write(source.join(name), "runtime").unwrap();
        }
        for directory in [
            "server/src",
            "server/node_modules",
            "server/.free-bot",
            "app/dist",
            "shared/Data",
            "Agents",
            ".git",
        ] {
            std::fs::create_dir_all(source.join(directory)).unwrap();
            std::fs::write(source.join(directory).join("private"), "excluded").unwrap();
        }
        std::fs::write(source.join("server/src/index.ts"), "local runtime").unwrap();
        std::fs::write(source.join("server/.env"), "secret").unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join(".env"), "saved installation").unwrap();
        copy_source(&source, &target).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("server/src/index.ts")).unwrap(),
            "local runtime"
        );
        assert_eq!(
            std::fs::read_to_string(target.join(".env")).unwrap(),
            "saved installation"
        );
        assert!(target.join("LICENSE").is_file());
        for path in [
            "server/.env",
            "server/node_modules",
            "server/.free-bot",
            "app/dist",
            "shared/Data",
            "Agents",
            ".git",
        ] {
            assert!(!target.join(path).exists(), "copied {path}");
        }
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn destination_links_cannot_overwrite_source_or_external_files() {
        let fixture = temp_root("free-bot-linked-deployment");
        let source = fixture.join("source");
        let target = fixture.join("deployment");
        let external = fixture.join("outside");
        std::fs::create_dir_all(source.join("server")).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        for name in FILES {
            std::fs::write(source.join(name), "original source").unwrap();
        }
        std::fs::write(source.join("server/index.ts"), "runtime source").unwrap();
        std::fs::write(external.join("index.ts"), "external data").unwrap();

        std::os::unix::fs::symlink(&source, &target).unwrap();
        assert!(copy_source(&source, &target).is_err());
        assert_eq!(
            std::fs::read_to_string(source.join("docker-compose.yml")).unwrap(),
            "original source"
        );
        std::fs::remove_file(&target).unwrap();

        std::fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&external, target.join("server")).unwrap();
        assert!(copy_source(&source, &target).is_err());
        assert_eq!(
            std::fs::read_to_string(external.join("index.ts")).unwrap(),
            "external data"
        );
        std::fs::remove_file(target.join("server")).unwrap();

        std::fs::remove_file(target.join("docker-compose.yml")).unwrap();
        std::os::unix::fs::symlink(
            source.join("docker-compose.yml"),
            target.join("docker-compose.yml"),
        )
        .unwrap();
        assert!(copy_source(&source, &target).is_err());
        assert_eq!(
            std::fs::read_to_string(source.join("docker-compose.yml")).unwrap(),
            "original source"
        );
        let alias = fixture.join("source-alias");
        std::os::unix::fs::symlink(&source, &alias).unwrap();
        assert!(copy_source(&source, &alias.join("nested-deployment")).is_err());
        assert!(!source.join("nested-deployment").exists());
        std::fs::remove_dir_all(fixture).unwrap();
    }
}
