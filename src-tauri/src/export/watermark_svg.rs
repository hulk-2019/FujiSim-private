use crate::error::{AppError, Result};
use image::RgbaImage;
use std::sync::Arc;

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
    let mut fontdb = usvg::fontdb::Database::new();
    fontdb.load_system_fonts();
    fontdb.set_sans_serif_family("Arial");
    fontdb.set_serif_family("Times New Roman");
    fontdb.set_monospace_family("Courier New");
    fontdb.set_cursive_family("Comic Sans MS");

    let mut opt = usvg::Options::default();
    opt.fontdb = Arc::new(fontdb);
    let tree =
        usvg::Tree::from_str(svg, &opt).map_err(|e| AppError::other(format!("svg parse: {e}")))?;
    let mut pixmap = tiny_skia::Pixmap::new(out_w, out_h)
        .ok_or_else(|| AppError::other("svg pixmap allocation failed"))?;
    let size = tree.size();
    let sx = out_w as f32 / size.width();
    let sy = out_h as f32 / size.height();
    let transform = tiny_skia::Transform::from_scale(sx, sy);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    let mut data = pixmap.take();
    for px in data.chunks_exact_mut(4) {
        let alpha = px[3] as u16;
        if alpha == 0 {
            continue;
        }
        for channel in &mut px[..3] {
            *channel = ((*channel as u16 * 255) / alpha).min(255) as u8;
        }
    }
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
            let scale = export_scale(settings, out_w, out_h);
            let position = settings
                .get("position")
                .and_then(|v| v.as_str())
                .unwrap_or("bottom-center");
            let (x, y, _, _, _) = anchor(position, out_w as f64, out_h as f64, scale);
            let offset_x = settings
                .get("offsetX")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
                * scale;
            let offset_y = settings
                .get("offsetY")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
                * scale;
            let rotation = settings
                .get("rotation")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let user_scale = settings
                .get("scale")
                .and_then(|v| v.as_f64())
                .unwrap_or(1.0)
                * scale;
            let flip_h = settings
                .get("flipH")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let flip_v = settings
                .get("flipV")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let sx = if flip_h { -user_scale } else { user_scale };
            let sy = if flip_v { -user_scale } else { user_scale };
            let opacity = settings
                .get("opacity")
                .and_then(|v| v.as_f64())
                .unwrap_or(1.0)
                .clamp(0.0, 1.0);
            let transform = format!(
                "translate({offset_x} {offset_y}) translate({x} {y}) rotate({rotation}) scale({sx} {sy}) translate({} {})",
                -x, -y
            );
            return Ok(format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" width="{out_w}" height="{out_h}" viewBox="0 0 {out_w} {out_h}"><g opacity="{opacity}" transform="{transform}">{body}</g></svg>"#
            ));
        }
    }

    let text = settings.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let color = settings
        .get("color")
        .and_then(|v| v.as_str())
        .unwrap_or("#ffffff");
    let font_family = settings
        .get("fontFamily")
        .and_then(|v| v.as_str())
        .map(normalize_font_family)
        .unwrap_or_else(|| "Arial".to_string());
    let opacity = settings
        .get("opacity")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0)
        .clamp(0.0, 1.0);
    let export_scale = export_scale(settings, out_w, out_h);
    let font_size = settings
        .get("fontSize")
        .and_then(|v| v.as_f64())
        .unwrap_or(32.0)
        * export_scale;
    let position = settings
        .get("position")
        .and_then(|v| v.as_str())
        .unwrap_or("bottom-center");
    let (x, y, dy, text_anchor, dominant_baseline) = anchor(position, out_w as f64, out_h as f64, export_scale);
    let offset_x = settings
        .get("offsetX")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        * export_scale;
    let offset_y = settings
        .get("offsetY")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        * export_scale;
    let rotation = settings
        .get("rotation")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let user_scale = settings
        .get("scale")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);
    let flip_h = settings
        .get("flipH")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let flip_v = settings
        .get("flipV")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let font_weight = if settings
        .get("bold")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        700
    } else {
        400
    };
    let italic_degree = settings
        .get("italicDegree")
        .and_then(|v| v.as_f64())
        .unwrap_or(15.0)
        .abs();
    let synthetic_italic = italic_degree > 0.0;
    let font_style = if settings
        .get("italic")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        "italic"
    } else {
        "normal"
    };
    let sx = if flip_h { -user_scale } else { user_scale };
    let sy = if flip_v { -user_scale } else { user_scale };
    let transform = format!(
        "translate({offset_x} {offset_y}) translate({x} {y}) rotate({rotation}) scale({sx} {sy}) translate({} {})",
        -x, -y
    );
    let text = format!(
        r#"<text x="{x}" y="{y}" dy="{dy}" text-anchor="{text_anchor}" dominant-baseline="{dominant_baseline}" font-family="{}" font-size="{font_size}" font-weight="{font_weight}" font-style="{font_style}" fill="{color}">{}</text>"#,
        xml_escape(&font_family),
        xml_escape(text)
    );
    let skew_y = y + dy;
    let body = if synthetic_italic {
        format!(
            r#"<g transform="translate({x} {skew_y}) skewX(-{italic_degree}) translate({} {})">{text}</g>"#,
            -x, -skew_y
        )
    } else {
        text
    };
    Ok(format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{out_w}" height="{out_h}" viewBox="0 0 {out_w} {out_h}"><g opacity="{opacity}" transform="{transform}">{body}</g></svg>"#
    ))
}

fn normalize_font_family(input: &str) -> String {
    input
        .split(',')
        .map(|part| part.trim().trim_matches('"').trim_matches('\''))
        .find(|part| {
            let lower = part.to_ascii_lowercase();
            !part.is_empty()
                && lower != "serif"
                && lower != "sans-serif"
                && lower != "monospace"
                && lower != "cursive"
                && lower != "fantasy"
        })
        .unwrap_or("Arial")
        .to_string()
}

fn export_scale(settings: &serde_json::Value, out_w: u32, out_h: u32) -> f64 {
    let preview_w = settings
        .get("previewWidth")
        .and_then(|v| v.as_f64())
        .filter(|v| *v > 0.0)
        .unwrap_or(out_w as f64);
    let preview_h = settings
        .get("previewHeight")
        .and_then(|v| v.as_f64())
        .filter(|v| *v > 0.0)
        .unwrap_or(out_h as f64);
    ((out_w as f64 / preview_w) + (out_h as f64 / preview_h)) / 2.0
}

fn anchor(position: &str, width: f64, height: f64, scale: f64) -> (f64, f64, f64, &'static str, &'static str) {
    let pad = 16.0 * scale;
    match position {
        "top-left" => (pad, 0.0, pad, "start", "hanging"),
        "top-center" => (width / 2.0, 0.0, pad, "middle", "hanging"),
        "top-right" => (width - pad, 0.0, pad, "end", "hanging"),
        "left-center" => (pad, height / 2.0, 0.0, "start", "middle"),
        "right-center" => (width - pad, height / 2.0, 0.0, "end", "middle"),
        "center" => (width / 2.0, height / 2.0, 0.0, "middle", "middle"),
        "bottom-left" => (pad, height, -pad, "start", "text-after-edge"),
        "bottom-right" => (width - pad, height, -pad, "end", "text-after-edge"),
        _ => (width / 2.0, height, -pad, "middle", "text-after-edge"),
    }
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
    fn rasterize_svg_returns_straight_alpha_pixels() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4"><rect width="4" height="4" fill="#ffffff" opacity="0.5"/></svg>"##;
        let img = rasterize_svg(svg, 4, 4).unwrap();
        let px = img.get_pixel(1, 1);
        assert!(px[3] >= 120 && px[3] <= 136);
        assert!(px[0] >= 250);
        assert!(px[1] >= 250);
        assert!(px[2] >= 250);
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

    #[test]
    fn build_text_watermark_svg_scales_preview_sized_settings_for_export() {
        let settings = serde_json::json!({
            "enabled": true,
            "kind": "text",
            "source": "builtin",
            "text": "FujiSim",
            "fontSize": 32,
            "fontFamily": "Arial, sans-serif",
            "color": "#ffffff",
            "opacity": 0.7,
            "bold": true,
            "italic": true,
            "italicDegree": 22,
            "position": "bottom-center",
            "offsetX": 0,
            "offsetY": 0,
            "scale": 1,
            "rotation": 0,
            "flipH": false,
            "flipV": false,
            "previewWidth": 600,
            "previewHeight": 400
        });
        let svg = build_watermark_svg_from_json(&settings, 6000, 4000).unwrap();
        assert!(svg.contains(r#"font-size="320""#));
        assert!(svg.contains(r#"font-family="Arial""#));
        assert!(svg.contains(r#"font-weight="700""#));
        assert!(svg.contains(r#"font-style="italic""#));
        assert!(svg.contains(r#"skewX(-22)"#));
        assert!(svg.contains(r#"translate(3000 3840) skewX(-22) translate(-3000 -3840)"#));
        assert!(svg.contains(r#"dy="-160""#));
        assert!(svg.contains(r#"y="4000""#));
    }

    #[test]
    fn build_text_watermark_svg_normalizes_css_font_stack_for_export() {
        let settings = serde_json::json!({
            "enabled": true,
            "kind": "text",
            "source": "builtin",
            "text": "FujiSim",
            "fontSize": 32,
            "fontFamily": "'Comic Sans MS', cursive",
            "color": "#ffffff",
            "opacity": 0.7,
            "italic": true,
            "italicDegree": 22,
            "position": "center",
            "offsetX": 0,
            "offsetY": 0,
            "scale": 1,
            "rotation": 0,
            "flipH": false,
            "flipV": false
        });
        let svg = build_watermark_svg_from_json(&settings, 600, 400).unwrap();
        assert!(svg.contains(r#"font-family="Comic Sans MS""#));
        assert!(svg.contains(r#"skewX(-22)"#));
    }

    #[test]
    fn build_text_watermark_svg_applies_italic_degree_without_font_italic_flag() {
        let settings = serde_json::json!({
            "enabled": true,
            "kind": "text",
            "source": "builtin",
            "text": "FujiSim",
            "fontSize": 32,
            "fontFamily": "'Comic Sans MS', cursive",
            "color": "#ffffff",
            "opacity": 0.7,
            "italic": false,
            "italicDegree": 22,
            "position": "center",
            "offsetX": 0,
            "offsetY": 0,
            "scale": 1,
            "rotation": 0,
            "flipH": false,
            "flipV": false
        });
        let svg = build_watermark_svg_from_json(&settings, 600, 400).unwrap();
        assert!(svg.contains(r#"font-style="normal""#));
        assert!(svg.contains(r#"skewX(-22)"#));
    }

    #[test]
    fn normalize_font_family_prefers_first_real_family() {
        assert_eq!(
            normalize_font_family("'Comic Sans MS', cursive"),
            "Comic Sans MS"
        );
        assert_eq!(normalize_font_family("sans-serif"), "Arial");
    }

    #[test]
    fn rasterized_generated_text_watermark_has_visible_pixels() {
        let settings = serde_json::json!({
            "enabled": true,
            "kind": "text",
            "source": "builtin",
            "text": "FujiSim",
            "fontSize": 32,
            "fontFamily": "Arial, sans-serif",
            "color": "#ffffff",
            "opacity": 0.7,
            "position": "center",
            "offsetX": 0,
            "offsetY": 0,
            "scale": 1,
            "rotation": 0,
            "flipH": false,
            "flipV": false
        });
        let svg = build_watermark_svg_from_json(&settings, 300, 200).unwrap();
        let img = rasterize_svg(&svg, 300, 200).unwrap();
        assert!(img.pixels().any(|p| p[3] > 0));
    }

    #[test]
    fn rasterized_italic_degree_changes_comic_sans_pixels() {
        let base = serde_json::json!({
            "enabled": true,
            "kind": "text",
            "source": "builtin",
            "text": "FujiSim",
            "fontSize": 54,
            "fontFamily": "'Comic Sans MS', cursive",
            "color": "#ffffff",
            "opacity": 1.0,
            "bold": false,
            "italic": true,
            "position": "center",
            "offsetX": 0,
            "offsetY": 0,
            "scale": 1,
            "rotation": 0,
            "flipH": false,
            "flipV": false
        });
        let mut mild = base.clone();
        mild["italicDegree"] = serde_json::json!(1);
        let mut strong = base;
        strong["italicDegree"] = serde_json::json!(35);

        let mild_svg = build_watermark_svg_from_json(&mild, 420, 220).unwrap();
        let strong_svg = build_watermark_svg_from_json(&strong, 420, 220).unwrap();
        let mild_img = rasterize_svg(&mild_svg, 420, 220).unwrap();
        let strong_img = rasterize_svg(&strong_svg, 420, 220).unwrap();

        assert_ne!(mild_img.as_raw(), strong_img.as_raw());
    }

    #[test]
    fn rasterized_italic_degree_changes_comic_sans_pixels_with_rotation() {
        let base = serde_json::json!({
            "enabled": true,
            "kind": "text",
            "source": "builtin",
            "text": "FujiSim",
            "fontSize": 54,
            "fontFamily": "'Comic Sans MS', cursive",
            "color": "#ffffff",
            "opacity": 1.0,
            "bold": false,
            "italic": false,
            "position": "center",
            "offsetX": 0,
            "offsetY": 0,
            "scale": 1,
            "rotation": 28,
            "flipH": false,
            "flipV": false
        });
        let mut mild = base.clone();
        mild["italicDegree"] = serde_json::json!(1);
        let mut strong = base;
        strong["italicDegree"] = serde_json::json!(35);

        let mild_svg = build_watermark_svg_from_json(&mild, 420, 220).unwrap();
        let strong_svg = build_watermark_svg_from_json(&strong, 420, 220).unwrap();
        let mild_img = rasterize_svg(&mild_svg, 420, 220).unwrap();
        let strong_img = rasterize_svg(&strong_svg, 420, 220).unwrap();

        assert_ne!(mild_img.as_raw(), strong_img.as_raw());
    }
}
