use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(default, deny_unknown_fields)]
pub struct DiskRulesConfig {
    pub use_defaults: bool,
    pub rules: Vec<DirectoryRule>,
}
impl Default for DiskRulesConfig {
    fn default() -> Self {
        Self {
            use_defaults: true,
            rules: Vec::new(),
        }
    }
}
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct DirectoryRule {
    pub path: String,
    #[serde(default)]
    pub depth: Option<u8>,
    #[serde(default)]
    pub class: Option<StorageClass>,
}
#[derive(Debug, Serialize, Clone)]
pub struct PluginRule {
    pub plugin: String,
    pub path: String,
}
#[derive(Debug, Serialize)]
pub struct RulesView {
    pub revision: String,
    pub home: String,
    pub roots: Vec<String>,
    pub config: DiskRulesConfig,
    pub defaults: Vec<DirectoryRule>,
    pub plugins: Vec<PluginRule>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RulesUpdate {
    pub revision: String,
    pub config: DiskRulesConfig,
}
pub fn defaults() -> DiskRulesConfig {
    toml::from_str(include_str!("../../disk-rules.toml")).expect("bundled directory rules")
}
pub fn validate(config: &DiskRulesConfig, home: &Path) -> Result<(), String> {
    if config.rules.len() > 128 {
        return Err("at most 128 custom directory rules are allowed".into());
    }
    let mut paths = HashSet::new();
    for rule in &config.rules {
        if rule.path.len() > 4096 || !paths.insert(expand(&rule.path, home)?) {
            return Err("directory rule paths must be unique and at most 4096 bytes".into());
        }
        if rule.depth.is_some_and(|depth| depth > 4) {
            return Err("directory rule depth must be between 0 and 4".into());
        }
    }
    Ok(())
}
#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum StorageClass {
    System,
    Apps,
    User,
    Reclaimable,
    Toolchain,
    Agentic,
    Library,
    Appdata,
}
impl StorageClass {
    pub fn label(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Apps => "apps",
            Self::User => "user",
            Self::Reclaimable => "reclaimable",
            Self::Toolchain => "toolchain",
            Self::Agentic => "agentic",
            Self::Library => "library",
            Self::Appdata => "appdata",
        }
    }
}
#[derive(Clone)]
pub struct Rules {
    entries: BTreeMap<PathBuf, DirectoryRule>,
}
pub fn expand(path: &str, home: &Path) -> Result<PathBuf, String> {
    let path = if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(path)
    };
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        || path.to_string_lossy().chars().any(char::is_control)
    {
        return Err("directory paths must be absolute or home-relative, without traversal or control characters".into());
    }
    Ok(path)
}
impl Rules {
    pub fn new(config: &DiskRulesConfig, home: &Path, plugins: &[PathBuf]) -> Result<Self, String> {
        validate(config, home)?;
        let defaults = defaults();
        let mut entries = BTreeMap::new();
        for rule in defaults.rules.iter().filter(|_| config.use_defaults) {
            entries.insert(expand(&rule.path, home)?, rule.clone());
        }
        for path in plugins {
            entries.entry(path.clone()).or_insert(DirectoryRule {
                path: path.to_string_lossy().into(),
                depth: Some(1),
                class: None,
            });
        }
        for rule in &config.rules {
            if rule.depth.is_some_and(|depth| depth > 4) {
                return Err("directory rule depth must be between 0 and 4".into());
            }
            let path = expand(&rule.path, home)?;
            // Expansion and classification overrides are independent.
            let mut replacement = rule.clone();
            if replacement.depth.is_none() {
                replacement.depth = entries.get(&path).and_then(|r| r.depth);
            }
            if replacement.class.is_none() {
                replacement.class = entries.get(&path).and_then(|r| r.class);
            }
            entries.insert(path, replacement);
        }
        // A deep declaration also makes its undeclared ancestors reachable.
        // An explicit ancestor (including depth=0) keeps its own policy.
        let declared = entries
            .iter()
            .filter(|(_, rule)| rule.depth.unwrap_or(0) > 0)
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        for path in declared {
            for parent in path.ancestors().skip(1) {
                if entries.contains_key(parent) {
                    break;
                }
                entries.insert(
                    parent.to_path_buf(),
                    DirectoryRule {
                        path: parent.to_string_lossy().into(),
                        depth: Some(1),
                        class: None,
                    },
                );
            }
        }
        Ok(Self { entries })
    }
    pub fn depth(&self, path: &Path) -> usize {
        self.entries
            .iter()
            .filter_map(|(base, rule)| {
                let depth = rule.depth?;
                path.strip_prefix(base).ok().map(|relative| {
                    (
                        base.components().count(),
                        usize::from(depth).saturating_sub(relative.components().count()),
                    )
                })
            })
            .max_by_key(|(specificity, _)| *specificity)
            .map_or(0, |(_, depth)| depth)
    }
    pub fn class(&self, path: &Path) -> &'static str {
        let class = self
            .entries
            .iter()
            .filter_map(|(base, rule)| {
                rule.class
                    .filter(|_| path.starts_with(base))
                    .map(|class| (base.components().count(), class))
            })
            .max_by_key(|(specificity, _)| *specificity)
            .map_or("user", |(_, class)| class.label());
        if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
            && !matches!(class, "system" | "reclaimable")
            && self
                .entries
                .get(path)
                .is_none_or(|rule| rule.class.is_none())
        {
            "apps"
        } else {
            class
        }
    }
    pub fn output_depth(&self, root: &Path, roots: &[String]) -> usize {
        self.entries
            .iter()
            .filter(|(path, rule)| {
                rule.depth.unwrap_or(0) > 0
                    && path.starts_with(root)
                    && !roots.iter().any(|other| {
                        let other = Path::new(other);
                        other != root && other.starts_with(root) && path.starts_with(other)
                    })
            })
            .map(|(path, rule)| {
                path.strip_prefix(root).unwrap().components().count()
                    + usize::from(rule.depth.unwrap_or(0))
            })
            .max()
            .unwrap_or(1)
            .clamp(1, 8)
    }
}
pub fn bundle(path: &Path) -> bool {
    path.extension().is_some_and(|ext| {
        matches!(
            ext.to_string_lossy().to_ascii_lowercase().as_str(),
            "app"
                | "framework"
                | "bundle"
                | "photoslibrary"
                | "photolibrary"
                | "vmwarevm"
                | "pvm"
                | "sparsebundle"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_are_path_scoped_and_overrides_keep_classification_independent() {
        let home = Path::new("/Users/test");
        let mut config = DiskRulesConfig::default();
        config.rules.push(DirectoryRule {
            path: "~/Library/Caches".into(),
            depth: Some(0),
            class: None,
        });
        let rules = Rules::new(&config, home, &[home.join("runners")]).unwrap();
        assert_eq!(rules.depth(&home.join("Library/Caches")), 0);
        assert_eq!(
            rules.class(&home.join("Library/Caches/Homebrew")),
            "reclaimable"
        );
        assert_eq!(rules.class(Path::new("/opt/homebrew/Cellar")), "toolchain");
        assert_eq!(rules.class(Path::new("/opt/homebrew/var")), "appdata");
        assert_eq!(rules.class(&home.join(".local/share")), "appdata");
        assert_eq!(rules.class(&home.join(".cargo")), "user");
        assert_eq!(rules.class(&home.join(".cargo/registry")), "reclaimable");
        assert_eq!(rules.depth(&home.join("runners")), 1);
        assert_eq!(rules.depth(&home.join("other/Applications")), 0);
        assert_eq!(rules.depth(Path::new("/Users/other/Library")), 0);
        assert_eq!(
            rules.output_depth(home, &[home.to_string_lossy().into(), "/".into()]),
            3
        );
        assert!(expand("../Library", home).is_err());
        assert!(expand("~/../other", home).is_err());
        assert!(bundle(Path::new("/Applications/Tool.APP")));
        config.rules.push(DirectoryRule {
            path: "~/projects/work/cache".into(),
            depth: Some(1),
            class: Some(StorageClass::Reclaimable),
        });
        let rules = Rules::new(&config, home, &[]).unwrap();
        assert_eq!(rules.depth(&home.join("projects")), 1);
        assert_eq!(rules.depth(&home.join("projects/work")), 1);
        assert_eq!(
            rules.class(&home.join("projects/work/cache/pkg")),
            "reclaimable"
        );
        config.rules.push(DirectoryRule {
            path: "~/work".into(),
            depth: Some(3),
            class: Some(StorageClass::User),
        });
        config.rules.push(DirectoryRule {
            path: "~/work/data".into(),
            depth: None,
            class: Some(StorageClass::Appdata),
        });
        config.rules.push(DirectoryRule {
            path: "~/work/Archive.app".into(),
            depth: None,
            class: Some(StorageClass::Appdata),
        });
        let rules = Rules::new(&config, home, &[]).unwrap();
        assert_eq!(rules.depth(&home.join("work/data")), 2);
        assert_eq!(rules.class(&home.join("work/Archive.app")), "appdata");
        config.rules.push(DirectoryRule {
            path: "~/bad".into(),
            depth: Some(5),
            class: None,
        });
        assert!(Rules::new(&config, home, &[]).is_err());
        let config = DiskRulesConfig {
            use_defaults: false,
            rules: vec![],
        };
        assert_eq!(
            Rules::new(&config, home, &[])
                .unwrap()
                .depth(&home.join("Library")),
            0
        );
    }
}
