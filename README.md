# <img src="./public/icon.png" width="32" align="absmiddle" /> FujiSim

[English](README.md) | [中文](docs/README_zh.md)

> High-Fidelity Fujifilm Simulation Desktop Application (MVP Phase: P0 + P1 + P2 core features fully implemented, RAW decoding interface reserved)

[![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=white)](#)
[![Rust](https://img.shields.io/badge/Rust-1.75+-000000?logo=rust&logoColor=white)](#)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](#)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-CSS-38B2AC?logo=tailwind-css&logoColor=white)](#)
[![SQLite](https://img.shields.io/badge/SQLite-DB-003B57?logo=sqlite&logoColor=white)](#)

A cross-platform desktop application based on **Tauri 2 + Rust + React 18 + TypeScript + Tailwind + SQLite**, implementing asset management, Fujifilm simulations, batch export, and other features.

![FujiSim Preview](./public/image.png)

---

## 📖 About

FujiSim is a desktop photo processing application built for photographers who love the distinctive look of Fujifilm film simulations — but want to apply them to any camera's images, not just Fujifilm bodies.

At its core is a **programmatic color engine** written in Rust that faithfully recreates Fujifilm's 13 classic film recipes (Provia, Velvia, Classic Chrome, Acros, and more) through per-channel curve bending, split toning, hue shifts, and grain simulation — all processed at **full 16-bit floating-point precision** to preserve tonal detail from highlight to shadow.

Beyond the built-in simulations, FujiSim doubles as a **3D LUT manager**: import any `.cube` LUT file and apply it alongside the same advanced tuning controls (highlights, shadows, clarity, white balance shift, grain). Your LUTs are copied into the app's data directory on import, so moving or deleting the originals never breaks your workflow.

The application is designed around a non-destructive, real-time editing loop — drag a slider and see the result in ~80 ms, hold the preview button for an instant A/B comparison against the original. When you're ready, a `rayon`-powered batch export engine processes your entire selection in parallel, writing out JPEG, PNG, TIFF, or WebP with optional text watermarks and flexible scaling options.

FujiSim is built with **Tauri 2** (Rust backend + React 18 frontend), keeping the binary lean and the UI native-feeling on both macOS and Windows — no Electron overhead, no Node.js runtime required.

---

## Minimum System Requirements

FujiSim's color pipeline runs on the GPU via wgpu (Metal on macOS, DX12 on Windows, Vulkan on Linux). Minimum supported configurations:

- **macOS**: 10.13+ (Metal capable)
- **Windows**: 10+ (DX12 capable)
- **Linux**: GPU driver supporting Vulkan or OpenGL 4.0+

If your system has no compatible GPU, FujiSim will refuse to start with a "no GPU adapter found" error — there is no CPU fallback.

---

## ✨ Implemented Features

### 📁 F1 Asset Management
- **Smart Import**: Supports **Directory Selection** (recursive scanning) and **Batch File Selection**, importing JPEG / PNG / TIFF / HEIF (RAW interface reserved).
- **Album-Aware Import**: When triggered within an album view, new assets are automatically associated with the current album.
- **Exif Parsing**: Automatically extracts metadata including Camera / Lens / ISO / Aperture / Shutter / Focal Length / Capture Time.
- **High-Performance View**: Grid view (lazy-loaded thumbnails) combined with detailed information panel.
- **Multi-Dimensional Filtering**: Filter assets by Camera, Rating, Sorting, Album, and Full-text Search.
- **Convenient Organization**: Star rating (0-5), virtual album creation, categorization, and deletion.
- **Batch Selection UX**: Each thumbnail exposes a hover-revealed checkbox; the list header offers a single-click select-all / deselect-all toggle with tri-state indicator (none / partial / all). Cmd/Ctrl-click and Shift-range selection are still supported.
- **Auto-Healed Selection**: After delete/move/filter operations, `selectedIds` is automatically narrowed to the new list and `focusedId` is restored to the next valid asset (preferring a still-selected one), so the canvas never goes blank.

### 🛠️ F2 File Operations
- **Batch Rename**: Supports flexible placeholder variables (e.g., `{date}_{camera}_{name}`).
- **Add to Album (formerly "Move")**: Select multiple assets and add them to a target album from a dropdown of existing albums. When triggered while viewing a specific album, the assets are also removed from the source album, achieving true cross-album move semantics. Physical files are never touched.
- **Safe Deletion**: Provides two deletion modes: "Remove Record Only" and "Move to System Trash".

### 🎨 F3 Core Color Engine (Fujifilm Simulation)
- **13 Built-in Classic Fujifilm Simulations**:
  Provia / Velvia / Astia / Classic Chrome / Pro Neg.Std / Pro Neg.Hi / Eterna / Classic Neg / Nostalgic Neg / Acros (+Y/+R) / Monochrome
- **Film Simulation Grouped Dropdown**: System presets (13 built-in Fuji recipes) and User custom (imported 3D LUTs) grouped in a single dropdown for selection.
- **User 3D LUT Library**: Supports batch importing `.cube` format LUTs, automatically copied to the app data directory (`<data_dir>/luts/`) upon import, moving/deleting source files will not affect the app; Supports both file selection (batch multi-select) and directory selection (recursive scanning) for import.
- **LUT Pass-Through Mode**: Automatically switches to Pass-Through recipe when a user LUT is selected, skipping Fuji Curves/Split Toning/Saturation steps, only utilizing user slider adjustments + LUT trilinear color lookup.
- **Programmatic Color Recipes**: Per-channel curve bending + Split toning + Saturation + Hue shift + Fading.
- **Grain Simulation**: Supports multiple intensity levels (None / Weak / Medium / Strong) and grain sizes (Small / Large).
- **Color Chrome Effect**: Increases color depth (None / Weak / Strong).
- **Advanced Tuning Panel**: Adjustments for Highlights / Shadows / Saturation / Clarity / Sharpness, as well as White Balance Shift (R-axis / B-axis, -9 to +9).
- **Preset Management**: User custom preset CRUD, built-in presets independently protected; Preset tab displays system presets and user customs synchronously (including LUT entries).
- **Real-time Preview**: 80ms debounce + GPU-accelerated color pipeline (wgpu + WGSL); ~25ms per frame on integrated GPUs, faster on discrete. Long edge 1280 hardware-level scaling, supports A/B view comparison (hold button to instantly view original image).

### 📤 F4 Batch Generation & Export
- **Bounded Concurrency**: Background asynchronous batch export, internally using a dedicated `rayon::ThreadPool` capped at **2 concurrent images**. Each image still uses pixel-level parallelism inside, but the outer cap keeps peak memory predictable on large RAWs (~1.4 GB peak on 6000×4000 instead of CPU-cores × image-size).
- **Multi-Format Support**: Export as JPEG (adjustable quality), PNG, TIFF, WebP.
- **Export Management**: Choose to export to a subfolder of the original directory or a global custom path.
- **Flexible Scaling**: Supports keeping original size, scaling proportionally by long edge, or scaling by percentage.
- **Real-time Tracking**: Real-time export progress pushed to the frontend UI via Tauri Events.

### 🧹 F5 Data & Lifecycle Hygiene
- **In-Memory LUT Cache**: Each `.cube` LUT is parsed once and held in an `Arc`-shared in-process cache, so slider drags and batch exports never re-read the file from disk. Deleting a user LUT also evicts the cached copy.
- **Streaming Memory Footprint**: The preview pipeline drops the source / resized / processed buffers as soon as the next stage finishes encoding, so RAM does not balloon while rendering one big image.
- **Event Listener Safety**: Frontend `listen()` registrations use a `cancelled` flag to handle the case where the component unmounts before the Promise resolves — no leaked subscriptions, no callbacks firing into unmounted React trees.
- **`reset_app_data` IPC**: A single command closes the SQLite pool (releasing `library.db-wal` / `-shm` handles), clears the in-memory LUT cache, and recursively removes the entire `Application Support/FujiSim/` directory. Use it for an in-app "reset" button or call it before uninstalling to guarantee zero residual files.

---

## 🏗️ Engineering Architecture

```text
├── docs/                          # README_zh.md
├── public/                        # images
├── src/                           # React Frontend
│   ├── components/                # Business UI components
│   │   ├── ui/                    # Base component library (shadcn/ui style)
│   │   │   ├── dropdown-menu.tsx  # Dropdown menu (import method selection)
│   │   │   └── ...                # button / dialog / select / slider / tabs
│   │   ├── Sidebar.tsx            # Top operation bar (import/filter/album/batch ops)
│   │   ├── AssetGrid.tsx          # Asset list (card grid view)
│   │   ├── PreviewPanel.tsx       # Central canvas (image preview and A/B comparison)
│   │   ├── FilterPanel.tsx        # Right operation area (parameter adjustment and metadata display)
│   │   ├── ExportDialog.tsx       # Batch export configuration dialog
│   │   └── StarRating.tsx         # Star rating component
│   ├── api.ts                     # Tauri IPC command encapsulation
│   ├── store.ts                   # Zustand global state management
│   ├── types.ts                   # Shared TS type definitions between frontend and backend
│   └── App.tsx                    # Top-level application layout
├── src-tauri/                     # Rust Backend Engine
│   ├── src/
│   │   ├── lib.rs                 # Tauri Builder entry
│   │   ├── ipc.rs                 # 28 #[tauri::command] API interfaces
│   │   ├── state.rs               # AppState (DB pool, LUT cache, export ThreadPool) + built-in preset seeding
│   │   ├── error.rs               # Custom Error layer
│   │   ├── db/                    # SQLite database persistence layer (Connection Pool + Schema)
│   │   │   └── user_luts.rs       # User 3D LUT library CRUD
│   │   ├── asset/                 # Directory scanning, file scanning, Exif parsing, file system operations
│   │   ├── processing/            # Core color engine pipeline (fuji presets, curves, LUT)
│   │   └── export/                # Asynchronous export and watermark imprinting module
│   └── Cargo.toml                 # Rust dependencies manifest
└── package.json                   # Frontend dependencies and startup scripts
```

---

## 💾 Database Location

The application's SQLite database is stored by default at:
- **macOS**: `~/Library/Application Support/FujiSim/library.db`

User-imported 3D LUT copies are stored at:
- **macOS**: `~/Library/Application Support/FujiSim/luts/`

> ⚠️ When starting the application for the first time, the system will automatically create tables and write 13 built-in Fujifilm presets.

---

## 🚀 Quick Start

1. **Install Frontend Dependencies** (First time use)
   ```bash
   pnpm install
   ```

2. **Start Development Mode** (Vite HMR + Tauri Monitor)
   ```bash
   pnpm tauri dev
   ```

> 💡 **Tip**: Running `cargo build` for the first time requires compiling 600+ crates, which may take 2-3 minutes. Subsequent incremental compilations will be very fast, usually completed within seconds.

---

## 📦 Build and Release

### Prerequisites

Before building for the first time, you need to add the corresponding platform build targets for Rust:

```bash
rustup target add aarch64-apple-darwin      # macOS Apple Silicon (M-series)
rustup target add x86_64-apple-darwin       # macOS Intel (Also required for Universal Binary)
rustup target add x86_64-pc-windows-msvc    # Windows x64 (Only valid in Windows environment)
```

### Build Commands

| Command | Artifact | Description |
|---|---|---|
| `pnpm build:mac-arm` | `.dmg` (arm64) | For Apple Silicon, M1/M2/M3/M4 |
| `pnpm build:mac-x64` | `.dmg` (x86_64) | For Intel Mac |
| `pnpm build:mac` | `.dmg` (Universal) | Single package supporting both arm64 + x86_64 (fat binary, larger size) |
| `pnpm build:win` | `.msi` / `.exe` | Windows x64, needs to be executed in Windows environment |

```bash
# Example: Build on Apple Silicon Mac
pnpm build:mac-arm

# Build Universal Binary (One package for Intel + Apple Silicon)
pnpm build:mac
```

### Build Output Directories

All build artifacts are uniformly output to the `target/<target>/release/bundle/` directory in the repository root (workspace mode, **not** `src-tauri/target/`). Specific paths are as follows:

| Command | `.app` / Executable | Installer Package |
|---|---|---|
| `pnpm build:mac-arm` | `target/aarch64-apple-darwin/release/bundle/macos/FujiSim.app` | `target/aarch64-apple-darwin/release/bundle/dmg/FujiSim_<version>_aarch64.dmg` |
| `pnpm build:mac-x64` | `target/x86_64-apple-darwin/release/bundle/macos/FujiSim.app` | `target/x86_64-apple-darwin/release/bundle/dmg/FujiSim_<version>_x64.dmg` |
| `pnpm build:mac` | `target/universal-apple-darwin/release/bundle/macos/FujiSim.app` | `target/universal-apple-darwin/release/bundle/dmg/FujiSim_<version>_universal.dmg` |
| `pnpm build:win` | `target/x86_64-pc-windows-msvc/release/FujiSim.exe` | `target/x86_64-pc-windows-msvc/release/bundle/msi/FujiSim_<version>_x64_en-US.msi`<br>`target/x86_64-pc-windows-msvc/release/bundle/nsis/FujiSim_<version>_x64-setup.exe` |

> 💡 The `<version>` in the filename is taken from the `version` field in [tauri.conf.json](src-tauri/tauri.conf.json), currently `1.0.1`.

### Notes

- **Windows Cross-compilation**: Tauri does not support cross-compiling from macOS to Windows, `build:win` must be run on a Windows machine or CI environment (e.g., GitHub Actions).
- **Universal Binary**: `build:mac` internally compiles both arm64 and x86_64, then merges them into a single fat binary using `lipo`, which takes about twice as long as a single architecture, and the artifact size is also nearly double. For faster builds or smaller sizes, use `build:mac-arm` / `build:mac-x64` instead.
- **Code Signing**: Before release, it is recommended to configure `bundle.macOS.signingIdentity` and `bundle.windows.certificateThumbprint` in `tauri.conf.json`, otherwise the system may pop up security warnings.
- **Clean Artifacts**: The `target/` directory is ignored in `.gitignore`; to free up disk space, you can manually `rm -rf target/`, and it will recompile next time.

---

## 🔧 RAW Decoding Integration Guide (Next Steps)

The backend `src-tauri/src/processing/raw.rs` has already reserved the `decode_raw_rgb16` interface, which currently returns `Unsupported` as it is in the MVP phase. To integrate RAW, simply:
1. `brew install libraw` (Install underlying decoding library)
2. Add `libraw-rs = "0.0.4"` or `rawloader = "0.37"` in `Cargo.toml`
3. Implement decoding logic in `raw.rs`: RAW → Linear 16-bit RGB → Bayer Demosaicing → Camera WB
4. The subsequent process is automatically taken over by `processing::load_image_rgb16`, no changes needed for the color pipeline!

---

## 📌 Known MVP Phase Limitations

- RAW decoding is not yet officially enabled (development postponed according to MVP requirement priorities).
- The feature to write complete Exif information back to new files is not implemented (currently only provides a "Remove GPS" switch in the UI).
- Multi-channel export of 16-bit TIFF format is currently degraded to 8-bit (but the color engine pipeline in memory still maintains 16-bit processing throughout).

---

## 💎 Technical Highlights

- ⚡️ **Full-link 16-bit Precision**: Decoding → Curves → Color Mapping → Grain Processing utilizes `f32` high-precision floating-point calculation throughout, only converting to `u16/u8` at the final saving step, maximally avoiding color banding.
- ⚡️ **Bounded rayon Parallelism**: A dedicated 2-thread `rayon::ThreadPool` for batch export keeps peak memory predictable on large RAWs while the per-image pixel-level parallelism still saturates the CPU.
- ⚡️ **Debounced Real-time Rendering**: `80ms` input merging debounce applied in frontend when dragging sliders, perfectly avoiding UI stuttering and preventing backend overload.
- ⚡️ **Process-Wide LUT Cache**: Parsed `.cube` LUTs are held behind an `Arc` and reused across previews and batch exports — slider drags and 1000-image exports incur exactly one disk read per LUT.
- ⚡️ **Zero External C/C++ Dependencies**: Pure Rust implementation (MVP phase), compile after installation, run after compilation, bid farewell to tedious environment configuration.
- ⚡️ **Clean Uninstall Path**: The `reset_app_data` command closes the DB pool, clears in-memory caches, and removes the entire data directory — perfect for an in-app reset or to wrap into an uninstaller script.