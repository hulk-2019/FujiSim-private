use serde::{Deserialize, Serialize};

/// 一个内置富士胶片模拟的"配方"参数集合。
///
/// 字段含义：
/// - `r_tilt`/`g_tilt`/`b_tilt`：分通道曲线的弯折量，决定预设的色彩偏好（Velvia 偏红、Classic Chrome 偏冷青等）；
/// - `contrast`：色调曲线 S 形强度，正值加硬、负值变柔；
/// - `saturation`：基础饱和度偏移（叠加在用户滑块之上）；
/// - `red_shift`/`green_shift`/`blue_shift`：整图色相微平移；
/// - `monochrome` + `mono_tint`：用于 Acros 系列与 Monochrome；
/// - `fade`：褪色量，用于 Eterna 这类低对比预设的"奶油"质感；
/// - `split_highlight`/`split_shadow`：高光区/阴影区的 RGB 染色系数（Split Toning）。
///
/// 这些数值不是从富士官方拿到的"科学解"，而是基于公开特征观察的近似配方，
/// 调出来的视觉风格接近真机直出 JPEG，可作为后期"二次创作起点"。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FotoProfile {
    pub name: &'static str,
    pub r_tilt: f32,
    pub g_tilt: f32,
    pub b_tilt: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub red_shift: f32,
    pub green_shift: f32,
    pub blue_shift: f32,
    pub hue_rotate: f32,
    pub monochrome: bool,
    pub mono_tint: (f32, f32, f32),
    pub fade: f32,
    pub split_highlight: (f32, f32, f32),
    pub split_shadow: (f32, f32, f32),
}

impl FotoProfile {
    /// 一个"无操作"基线，所有偏移都为 0。其它预设通过 struct update syntax 在此之上覆盖关键字段。
    pub const fn neutral(name: &'static str) -> Self {
        Self {
            name,
            r_tilt: 0.0,
            g_tilt: 0.0,
            b_tilt: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            red_shift: 0.0,
            green_shift: 0.0,
            blue_shift: 0.0,
            hue_rotate: 0.0,
            monochrome: false,
            mono_tint: (1.0, 1.0, 1.0),
            fade: 0.0,
            split_highlight: (1.0, 1.0, 1.0),
            split_shadow: (1.0, 1.0, 1.0),
        }
    }
}

/// 名字到配方的查表。未知名字回退到 Provia（最中性）。
///
/// 这里硬编码 13 个内置预设的特征值，调色师可以直接在源码中调整某个预设的味道，
/// 重启即可生效——种子写入逻辑会用 UPSERT 同步到 SQLite。
pub fn lookup(name: &str) -> FotoProfile {
    match name {
        // "Pass-Through" 是为"用户自定义 LUT"分支准备的恒等配方：
        // 所有偏移都是 0，pipeline 中的曲线/Split Toning/饱和度等步骤天然变成 no-op，
        // 真正起作用的就只有用户滑块（高光/阴影等）和外挂 LUT。
        "Pass-Through" => FotoProfile::neutral("Pass-Through"),
        "Provia" => FotoProfile {
            name: "Provia",
            contrast: 0.15,
            saturation: 0.10,
            r_tilt: 0.02,
            g_tilt: 0.0,
            b_tilt: -0.02,
            split_highlight: (1.02, 1.0, 0.98),
            split_shadow: (0.98, 1.0, 1.02),
            ..FotoProfile::neutral("Provia")
        },
        "Velvia" => FotoProfile {
            name: "Velvia",
            contrast: 0.35,
            saturation: 0.55,
            r_tilt: 0.08,
            g_tilt: 0.04,
            b_tilt: -0.05,
            red_shift: 0.06,
            green_shift: 0.05,
            blue_shift: -0.04,
            split_highlight: (1.06, 1.02, 0.96),
            split_shadow: (1.02, 1.0, 0.94),
            ..FotoProfile::neutral("Velvia")
        },
        "Astia" => FotoProfile {
            name: "Astia",
            contrast: 0.05,
            saturation: -0.05,
            r_tilt: 0.03,
            g_tilt: 0.0,
            b_tilt: 0.0,
            red_shift: 0.02,
            split_highlight: (1.03, 1.0, 0.97),
            split_shadow: (1.0, 1.0, 1.02),
            ..FotoProfile::neutral("Astia")
        },
        "Classic Chrome" => FotoProfile {
            name: "Classic Chrome",
            contrast: 0.25,
            saturation: -0.20,
            r_tilt: -0.02,
            g_tilt: 0.0,
            b_tilt: 0.05,
            red_shift: -0.05,
            blue_shift: 0.06,
            fade: 0.12,
            split_highlight: (0.96, 0.98, 1.04),
            split_shadow: (0.94, 0.96, 1.06),
            ..FotoProfile::neutral("Classic Chrome")
        },
        "Pro Neg Std" => FotoProfile {
            name: "Pro Neg Std",
            contrast: -0.10,
            saturation: -0.15,
            r_tilt: 0.01,
            ..FotoProfile::neutral("Pro Neg Std")
        },
        "Pro Neg Hi" => FotoProfile {
            name: "Pro Neg Hi",
            contrast: 0.10,
            saturation: -0.05,
            r_tilt: 0.02,
            ..FotoProfile::neutral("Pro Neg Hi")
        },
        "Eterna" => FotoProfile {
            name: "Eterna",
            contrast: -0.20,
            saturation: -0.30,
            r_tilt: -0.02,
            g_tilt: 0.01,
            b_tilt: 0.03,
            fade: 0.18,
            split_highlight: (0.96, 1.0, 1.04),
            split_shadow: (1.02, 1.0, 0.96),
            ..FotoProfile::neutral("Eterna")
        },
        "Classic Neg" => FotoProfile {
            name: "Classic Neg",
            contrast: 0.30,
            saturation: 0.05,
            r_tilt: 0.05,
            g_tilt: -0.03,
            b_tilt: 0.04,
            red_shift: 0.04,
            green_shift: -0.06,
            blue_shift: 0.05,
            fade: 0.08,
            split_highlight: (1.04, 0.96, 0.98),
            split_shadow: (0.92, 0.96, 1.05),
            ..FotoProfile::neutral("Classic Neg")
        },
        "Nostalgic Neg" => FotoProfile {
            name: "Nostalgic Neg",
            contrast: 0.10,
            saturation: 0.0,
            r_tilt: 0.04,
            g_tilt: -0.01,
            b_tilt: -0.03,
            red_shift: 0.05,
            blue_shift: -0.04,
            fade: 0.16,
            split_highlight: (1.05, 1.0, 0.94),
            split_shadow: (1.02, 0.98, 0.92),
            ..FotoProfile::neutral("Nostalgic Neg")
        },
        "Acros" => FotoProfile {
            name: "Acros",
            contrast: 0.30,
            saturation: 0.0,
            monochrome: true,
            mono_tint: (1.0, 1.0, 1.0),
            ..FotoProfile::neutral("Acros")
        },
        "Acros + Y" => FotoProfile {
            name: "Acros + Y",
            contrast: 0.30,
            monochrome: true,
            mono_tint: (1.10, 1.0, 0.85),
            ..FotoProfile::neutral("Acros + Y")
        },
        "Acros + R" => FotoProfile {
            name: "Acros + R",
            contrast: 0.35,
            monochrome: true,
            mono_tint: (1.30, 0.9, 0.7),
            ..FotoProfile::neutral("Acros + R")
        },
        "Monochrome" => FotoProfile {
            name: "Monochrome",
            contrast: 0.15,
            monochrome: true,
            ..FotoProfile::neutral("Monochrome")
        },
        _ => FotoProfile::neutral("Provia"),
    }
}

/// 13 个内置预设的名字。应用启动时按此顺序写入 `filter_presets` 表（is_builtin=1）。
pub const BUILTIN_NAMES: &[&str] = &[
    "Provia",
    "Velvia",
    "Astia",
    "Classic Chrome",
    "Pro Neg Std",
    "Pro Neg Hi",
    "Eterna",
    "Classic Neg",
    "Nostalgic Neg",
    "Acros",
    "Acros + Y",
    "Acros + R",
    "Monochrome",
];
