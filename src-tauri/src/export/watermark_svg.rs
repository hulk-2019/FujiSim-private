use crate::error::{AppError, Result};
use image::RgbaImage;

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

pub fn rasterize_svg(svg: &str, out_w: u32, out_h: u32) -> Result<RgbaImage> {
    let opt = usvg::Options::default();
    let tree =
        usvg::Tree::from_str(svg, &opt).map_err(|e| AppError::other(format!("svg parse: {e}")))?;
    let mut pixmap = tiny_skia::Pixmap::new(out_w, out_h)
        .ok_or_else(|| AppError::other("svg pixmap allocation failed"))?;
    let size = tree.size();
    let sx = out_w as f32 / size.width();
    let sy = out_h as f32 / size.height();
    let transform = tiny_skia::Transform::from_scale(sx, sy);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    let data = pixmap.take();
    RgbaImage::from_raw(out_w, out_h, data)
        .ok_or_else(|| AppError::other("svg rgba buffer mismatch"))
}

pub fn build_watermark_svg_from_json(
    settings: &serde_json::Value,
    out_w: u32,
    out_h: u32,
) -> Result<String> {
    let kind = settings
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("text");
    if kind == "svg" {
        if let Some(markup) = settings.get("svgMarkup").and_then(|v| v.as_str()) {
            let body = apply_svg_overrides(markup, settings)?;
            return Ok(format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" width="{out_w}" height="{out_h}" viewBox="0 0 {out_w} {out_h}">{body}</svg>"#
            ));
        }
    }

    let text = settings.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let color = settings
        .get("color")
        .and_then(|v| v.as_str())
        .unwrap_or("#ffffff");
    let opacity = settings
        .get("opacity")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0)
        .clamp(0.0, 1.0);
    let font_size = settings
        .get("fontSize")
        .and_then(|v| v.as_f64())
        .unwrap_or(32.0);
    let x = out_w as f64 / 2.0;
    let y = out_h as f64 - 16.0;
    Ok(format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{out_w}" height="{out_h}" viewBox="0 0 {out_w} {out_h}"><g opacity="{opacity}"><text x="{x}" y="{y}" text-anchor="middle" font-size="{font_size}" fill="{color}">{}</text></g></svg>"#,
        xml_escape(text)
    ))
}

fn apply_svg_overrides(markup: &str, settings: &serde_json::Value) -> Result<String> {
    let mut next = sanitize_svg(markup)?;
    if let Some(text) = settings.get("svgTextOverride").and_then(|v| v.as_str()) {
        let re = regex::Regex::new(r"(?is)<text([^>]*)>.*?</text>").unwrap();
        next = re
            .replace_all(&next, format!("<text$1>{}</text>", xml_escape(text)))
            .into_owned();
    }
    if let Some(fill) = settings.get("svgFillOverride").and_then(|v| v.as_str()) {
        let re = regex::Regex::new(r#"\sfill=(["'])(?!none\b)[^"']*\1"#).unwrap();
        next = re.replace_all(&next, format!(r#" fill="{fill}""#)).into_owned();
        next = next.replace("currentColor", fill);
    }
    if let Some(stroke) = settings.get("svgStrokeOverride").and_then(|v| v.as_str()) {
        let re = regex::Regex::new(r#"\sstroke=(["'])(?!none\b)[^"']*\1"#).unwrap();
        next = re
            .replace_all(&next, format!(r#" stroke="{stroke}""#))
            .into_owned();
    }
    Ok(next)
}

fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
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

    #[test]
    fn render_svg_watermark_outputs_rgba_pixels() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10"><rect width="20" height="10" fill="#ffffff"/></svg>"##;
        let img = rasterize_svg(svg, 20, 10).unwrap();
        assert_eq!(img.width(), 20);
        assert_eq!(img.height(), 10);
        assert!(img.pixels().any(|p| p[3] > 0));
    }

    #[test]
    fn build_text_watermark_svg_uses_output_size() {
        let settings = serde_json::json!({
            "enabled": true,
            "kind": "text",
            "source": "builtin",
            "text": "FujiSim",
            "fontSize": 32,
            "fontFamily": "Arial, sans-serif",
            "color": "#ffffff",
            "opacity": 0.7,
            "position": "bottom-center",
            "offsetX": 0,
            "offsetY": 0,
            "scale": 1,
            "rotation": 0,
            "flipH": false,
            "flipV": false
        });
        let svg = build_watermark_svg_from_json(&settings, 600, 400).unwrap();
        assert!(svg.contains(r#"width="600""#));
        assert!(svg.contains("FujiSim"));
    }
}
