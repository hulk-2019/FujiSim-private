use crate::error::{AppError, Result};

pub fn sanitize_svg(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if !trimmed.to_ascii_lowercase().starts_with("<svg") {
        return Err(AppError::other("svg root required"));
    }
    let mut out = trimmed.to_string();
    for tag in ["script", "foreignObject", "animate", "set"] {
        let pattern = regex::Regex::new(&format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}>")).unwrap();
        out = pattern.replace_all(&out, "").into_owned();
    }
    let event_attr = regex::Regex::new(r#"(?i)\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*')"#).unwrap();
    out = event_attr.replace_all(&out, "").into_owned();
    let remote_href =
        regex::Regex::new(r#"(?i)\s+(href|xlink:href)\s*=\s*["']https?://[^"']*["']"#)
            .unwrap();
    out = remote_href.replace_all(&out, "").into_owned();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_removes_scripts_and_event_handlers() {
        let input = r#"<svg viewBox="0 0 10 10"><script>alert(1)</script><path onclick="x()" fill="red" d="M0 0h10v10H0z"/></svg>"#;
        let out = sanitize_svg(input).unwrap();
        assert!(!out.contains("<script"));
        assert!(!out.contains("onclick"));
        assert!(out.contains("viewBox"));
    }

    #[test]
    fn sanitize_requires_svg_root() {
        assert!(sanitize_svg("<div></div>").is_err());
    }
}
