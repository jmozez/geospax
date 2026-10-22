//! The guides, built into the program so Help opens them in every edition (web, desktop window,
//! phone) without a docs folder next to the binary. Served by `GET /api/docs/<NAME>`.

/// (name, title, markdown)
pub const DOCS: &[(&str, &str, &str)] = &[
    ("USER_GUIDE", "User guide", include_str!("../../../docs/USER_GUIDE.md")),
    ("AUTOMATION", "Automation", include_str!("../../../docs/AUTOMATION.md")),
    ("FEATURE_MATRIX", "Feature matrix", include_str!("../../../docs/FEATURE_MATRIX.md")),
    ("GSX", "GSX tools and domain kits", include_str!("../../../docs/GSX.md")),
    ("R", "R in GeoSpaX", include_str!("../../../docs/R.md")),
    ("PLUGINS", "Plugins", include_str!("../../../docs/PLUGINS.md")),
    ("DEVICES", "Devices", include_str!("../../../docs/DEVICES.md")),
    ("VISION", "Vision", include_str!("../../../docs/VISION.md")),
    ("README", "About GeoSpaX", include_str!("../../../README.md")),
    ("CHANGELOG", "What's new", include_str!("../../../CHANGELOG.md")),
    ("SECURITY", "Security", include_str!("../../../SECURITY.md")),
    ("THIRD_PARTY_NOTICES", "Credits", include_str!("../../../THIRD_PARTY_NOTICES.md")),
];

/// A guide by name (`USER_GUIDE`, `user_guide.md`, `docs/USER_GUIDE.md`, `../README.md` …).
pub fn find(name: &str) -> Option<(&'static str, &'static str, &'static str)> {
    let base = name.rsplit('/').next().unwrap_or(name);
    let base = base.split('#').next().unwrap_or(base);
    let base = base.strip_suffix(".md").unwrap_or(base);
    DOCS.iter().copied().find(|(n, _, _)| n.eq_ignore_ascii_case(base))
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_guides_by_any_link_form() {
        assert_eq!(super::find("USER_GUIDE").unwrap().1, "User guide");
        assert_eq!(super::find("docs/AUTOMATION.md#2-recipe-format").unwrap().0, "AUTOMATION");
        assert_eq!(super::find("../README.md").unwrap().0, "README");
        assert!(super::find("../../etc/passwd").is_none());
        assert!(super::DOCS.iter().all(|(_, _, md)| md.len() > 200));
    }
}
