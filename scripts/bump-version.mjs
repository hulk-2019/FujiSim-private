#!/usr/bin/env node
// 把 package.json 的 version 同步到 src-tauri/tauri.conf.json 和 src-tauri/Cargo.toml。
// 在每次 `pnpm build:*` 之前由 prebuild 钩子自动调用。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function syncTauriConf(version) {
  const file = path.join(ROOT, "src-tauri/tauri.conf.json");
  const conf = await readJson(file);
  if (conf.version === version) return false;
  conf.version = version;
  await writeFile(file, JSON.stringify(conf, null, 2) + "\n", "utf8");
  return true;
}

async function syncCargoToml(version) {
  const file = path.join(ROOT, "src-tauri/Cargo.toml");
  const content = await readFile(file, "utf8");
  const re = /^(version\s*=\s*)"[^"]*"/m;
  if (!re.test(content)) {
    throw new Error("src-tauri/Cargo.toml 的 [package] 段缺少 version 字段");
  }
  const next = content.replace(re, `$1"${version}"`);
  if (next === content) return false;
  await writeFile(file, next, "utf8");
  return true;
}

async function main() {
  const pkg = await readJson(path.join(ROOT, "package.json"));
  const version = pkg.version;
  if (!version) throw new Error("package.json 缺少 version 字段");

  const tauriChanged = await syncTauriConf(version);
  const cargoChanged = await syncCargoToml(version);

  console.log(
    `[version:sync] package.json=${version}, tauri.conf.json=${tauriChanged ? "updated" : "unchanged"}, Cargo.toml=${cargoChanged ? "updated" : "unchanged"}`
  );
}

main().catch((e) => {
  console.error(`[version:sync] failed: ${e.message}`);
  process.exit(1);
});
