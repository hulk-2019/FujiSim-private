//! GPU compute pipeline for the color flow.
//!
//! Owns a single [`context::GpuContext`] for the process. See
//! `docs/superpowers/specs/2026-05-25-webgpu-pipeline-design.md` for the design.

pub mod context;
pub mod curves_bake;
pub mod passes;
pub mod passthrough;
pub mod uniforms;
pub mod upload;

#[cfg(test)]
mod tests;
