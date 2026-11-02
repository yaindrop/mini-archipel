use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    schema_version: u32,
    pub id: String,
    pub legacy_ids: Option<Vec<String>>,
    bundle_id: Option<String>,
    services: Option<BTreeMap<String, Service>>,
    paths: Option<BTreeMap<String, Resource>>,
    commands: Option<BTreeMap<String, Command>>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Owner {
    Plugin,
    External,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Domain {
    Gui,
    System,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Service {
    label: Option<String>,
    label_pattern: Option<String>,
    legacy_labels: Option<Vec<String>>,
    domain: Domain,
    owner: Owner,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Migration {
    Move,
    Fixed,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Program,
    State,
    Backup,
    Log,
    App,
    Socket,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    path: String,
    legacy_paths: Option<Vec<String>>,
    kind: Kind,
    owner: Owner,
    migration: Migration,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Command {
    path: String,
    target: Option<String>,
    legacy_paths: Option<Vec<String>>,
    // Deserialization validates the ownership even though commands are not executed here.
    #[serde(rename = "owner")]
    _owner: Owner,
}

fn valid_id(value: &str) -> bool {
    value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

fn valid_label(value: &str) -> bool {
    value.split(['.', '-']).all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|character| character.is_ascii_alphanumeric())
    })
}

fn valid_path(value: &str) -> bool {
    let Some(relative) = value.strip_prefix("~/").or_else(|| value.strip_prefix('/')) else {
        return false;
    };
    !value
        .chars()
        .any(|c| c.is_ascii_control() || matches!(c, '$' | '`' | '*'))
        && relative
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn valid_aliases(values: &Option<Vec<String>>, valid: fn(&str) -> bool) -> bool {
    values.as_ref().is_none_or(|values| {
        !values.is_empty()
            && values.iter().all(|value| valid(value))
            && values.iter().collect::<HashSet<_>>().len() == values.len()
    })
}

fn valid_table<T>(table: &Option<BTreeMap<String, T>>) -> bool {
    table.as_ref().is_none_or(|table| {
        !table.is_empty()
            && table.keys().all(|key| {
                key.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                    && key
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
            })
    })
}

fn valid_paths(path: &str, legacy: &Option<Vec<String>>) -> bool {
    valid_path(path)
        && valid_aliases(legacy, valid_path)
        && !legacy.iter().flatten().any(|old| old == path)
}

impl Manifest {
    pub fn parse(source: &str, expected_id: &str) -> Result<Self, String> {
        let manifest: Self =
            toml::from_str(source).map_err(|_| "invalid manifest TOML or fields")?;
        if manifest.schema_version != 1 || !valid_id(&manifest.id) || manifest.id != expected_id {
            return Err("manifest version or plugin ID mismatch".into());
        }
        if !valid_aliases(&manifest.legacy_ids, valid_id)
            || manifest
                .legacy_ids
                .iter()
                .flatten()
                .any(|alias| alias == &manifest.id)
            || manifest
                .bundle_id
                .as_ref()
                .is_some_and(|id| !valid_label(id))
            || !valid_table(&manifest.services)
            || !valid_table(&manifest.paths)
            || !valid_table(&manifest.commands)
        {
            return Err("invalid manifest aliases, identity or resource tables".into());
        }
        for service in manifest.services.iter().flat_map(|table| table.values()) {
            let label = service.label.as_ref();
            let pattern = service.label_pattern.as_ref();
            if label.is_some() == pattern.is_some()
                || label.is_some_and(|label| !valid_label(label))
                || !valid_aliases(&service.legacy_labels, valid_label)
                || pattern.is_some_and(|pattern| {
                    service.owner != Owner::External
                        || service.legacy_labels.is_some()
                        || !pattern.strip_suffix(".*").is_some_and(valid_label)
                })
                || (service.owner == Owner::Plugin
                    && !label.is_some_and(|label| label.starts_with("local.miniarchipel.")))
            {
                return Err("invalid manifest service label or ownership".into());
            }
        }
        for resource in manifest.paths.iter().flat_map(|table| table.values()) {
            if !valid_paths(&resource.path, &resource.legacy_paths) {
                return Err("invalid manifest resource path".into());
            }
            if resource.migration == Migration::Fixed {
                continue;
            }
            let root = match resource.kind {
                Kind::Program => format!("~/.local/libexec/mini-archipel/{}", manifest.id),
                Kind::State | Kind::Backup => {
                    format!("~/.local/share/mini-archipel/{}", manifest.id)
                }
                Kind::Log => format!("~/Library/Logs/MiniArchipel/{}", manifest.id),
                Kind::App | Kind::Socket => return Err("App and socket paths must be fixed".into()),
            };
            if resource.owner != Owner::Plugin
                || (resource.path != root && !resource.path.starts_with(&(root + "/")))
            {
                return Err("movable resources must use their owned canonical directory".into());
            }
        }
        for command in manifest.commands.iter().flat_map(|table| table.values()) {
            if !valid_paths(&command.path, &command.legacy_paths)
                || command
                    .target
                    .as_ref()
                    .is_some_and(|target| !valid_path(target))
            {
                return Err("invalid manifest command path".into());
            }
        }
        Ok(manifest)
    }
}

pub fn validate_catalog(manifests: &[Manifest]) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut labels = HashSet::new();
    for manifest in manifests {
        for id in std::iter::once(&manifest.id).chain(manifest.legacy_ids.iter().flatten()) {
            if !ids.insert(id) {
                return Err("duplicate registered plugin ID or alias".into());
            }
        }
        for service in manifest.services.iter().flat_map(|table| table.values()) {
            for label in service
                .label
                .iter()
                .chain(service.label_pattern.iter())
                .chain(service.legacy_labels.iter().flatten())
            {
                if !labels.insert(format!("{:?}/{label}", service.domain)) {
                    return Err("duplicate registered service label".into());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = include_str!("../../../plugins/proxy/manifest.toml");

    #[test]
    fn accepts_declared_legacy_paths_without_filesystem_access() {
        let manifest = Manifest::parse(SOURCE, "proxy").unwrap();
        assert_eq!(
            manifest.paths.as_ref().unwrap()["program"]
                .legacy_paths
                .as_ref()
                .unwrap(),
            &["~/.local/mini-proxy"]
        );
        validate_catalog(&[manifest]).unwrap();
        assert!(crate::plugins::catalog::installed().is_ok());
    }

    #[test]
    fn rejects_invalid_manifest_and_resource_boundaries() {
        for source in [
            SOURCE.replace("schema_version = 1", "schema_version = 2"),
            SOURCE.replace("schema_version = 1", "schema_version = 1\nunknown = true"),
            SOURCE.replace("id = \"proxy\"", "id = \"other\""),
            SOURCE.replace("owner = \"plugin\"", "owner = \"external\""),
            SOURCE.replace(
                "~/.local/libexec/mini-archipel/proxy",
                "~/.local/libexec/mini-archipel/other",
            ),
            SOURCE.replace("~/.local/mini-proxy", "~/../mini-proxy"),
            SOURCE.replace("legacy_ids = [\"mini-proxy\"]", "legacy_ids = [\"proxy\"]"),
            "schema_version = 1\nid = \"proxy\"\n[services]\n".into(),
        ] {
            assert!(
                Manifest::parse(&source, "proxy").is_err(),
                "accepted invalid manifest"
            );
        }
    }

    #[test]
    fn rejects_catalog_collisions() {
        let first = Manifest::parse(SOURCE, "proxy").unwrap();
        let mut second = Manifest::parse(SOURCE, "proxy").unwrap();
        second.id = "other".into();
        assert!(validate_catalog(&[first, second]).is_err());
        let first = Manifest::parse(SOURCE, "proxy").unwrap();
        let mut second = Manifest::parse(SOURCE, "proxy").unwrap();
        second.id = "other".into();
        second.legacy_ids = None;
        assert!(validate_catalog(&[first, second]).is_err());
    }
}
