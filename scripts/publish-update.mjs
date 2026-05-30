#!/usr/bin/env node
// 收集打包产物 + 生成 latest.json + 上传阿里云 OSS。
// 前置：环境变量需通过 `set -a; source .env.production.local; set +a` 加载。

import OSS from "ali-oss";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const REQUIRED_ENV = [
  "ALIYUN_OSS_ACCESS_KEY_ID",
  "ALIYUN_OSS_ACCESS_KEY_SECRET",
  "ALIYUN_OSS_BUCKET",
  "ALIYUN_OSS_REGION",
  "ALIYUN_OSS_DOMAIN",
];

function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing env vars: ${missing.join(", ")}. Did you 'source .env.production.local'?`
    );
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function bundleDir(target) {
  return path.join(ROOT, "src-tauri/target", target, "release/bundle/macos");
}

function suffixFor(target) {
  if (target.includes("universal")) return "universal";
  if (target.includes("aarch64")) return "aarch64";
  if (target.includes("x86_64")) return "x64";
  return target;
}

function platformKey(target) {
  if (target.includes("aarch64") || target.includes("universal")) {
    return "darwin-aarch64";
  }
  if (target.includes("x86_64")) return "darwin-x86_64";
  return null;
}

async function findArtifacts(version) {
  const candidates = [
    "universal-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
  ];
  const found = {};
  for (const target of candidates) {
    const dir = bundleDir(target);
    if (!existsSync(dir)) continue;
    const tarGz = path.join(dir, `FotoForge_${version}_${suffixFor(target)}.app.tar.gz`);
    const sig = `${tarGz}.sig`;
    const dmg = path.join(
      ROOT,
      "src-tauri/target",
      target,
      "release/bundle/dmg",
      `FotoForge_${version}_${suffixFor(target)}.dmg`
    );
    if (existsSync(tarGz) && existsSync(sig)) {
      found[target] = { tarGz, sig, dmg: existsSync(dmg) ? dmg : null };
    }
  }
  return found;
}

function urlFor(remoteKey) {
  return `https://${process.env.ALIYUN_OSS_DOMAIN}/${remoteKey}`;
}

async function main() {
  checkEnv();
  const pkg = await readJson(path.join(ROOT, "package.json"));
  const version = pkg.version;
  console.log(`[publish] version = ${version}`);

  const artifacts = await findArtifacts(version);
  if (Object.keys(artifacts).length === 0) {
    throw new Error("没有找到任何打包产物。先跑 pnpm build:mac");
  }

  const client = new OSS({
    region: process.env.ALIYUN_OSS_REGION,
    accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
    bucket: process.env.ALIYUN_OSS_BUCKET,
  });

  const prefix = process.env.ALIYUN_OSS_PATH_PREFIX || "fotoforge";
  const platforms = {};

  for (const [target, files] of Object.entries(artifacts)) {
    const pkey = platformKey(target);
    if (!pkey) continue;

    const remoteTarGz = `${prefix}/releases/${version}/${path.basename(files.tarGz)}`;
    const remoteSig = `${prefix}/releases/${version}/${path.basename(files.sig)}`;

    console.log(`[publish] uploading ${remoteTarGz}`);
    await client.put(remoteTarGz, files.tarGz, {
      headers: { "Cache-Control": "public, max-age=2592000" },
    });

    console.log(`[publish] uploading ${remoteSig}`);
    await client.put(remoteSig, files.sig, {
      headers: { "Cache-Control": "public, max-age=2592000" },
    });

    if (files.dmg) {
      const remoteDmg = `${prefix}/releases/${version}/${path.basename(files.dmg)}`;
      console.log(`[publish] uploading ${remoteDmg}`);
      await client.put(remoteDmg, files.dmg, {
        headers: { "Cache-Control": "public, max-age=2592000" },
      });
    }

    const signature = await readFile(files.sig, "utf8");
    platforms[pkey] = {
      signature: signature.trim(),
      url: urlFor(remoteTarGz),
    };

    if (target.includes("universal")) {
      platforms["darwin-x86_64"] = platforms[pkey];
    }
  }

  const latest = {
    version,
    notes: pkg.description || "",
    pub_date: new Date().toISOString(),
    platforms,
  };

  const latestPath = path.join(ROOT, "dist-updates/latest.json");
  await mkdir(path.dirname(latestPath), { recursive: true });
  await writeFile(latestPath, JSON.stringify(latest, null, 2), "utf8");

  const remoteLatest = `${prefix}/latest.json`;
  console.log(`[publish] uploading ${remoteLatest}`);
  await client.put(remoteLatest, latestPath, {
    headers: { "Cache-Control": "no-cache, max-age=0" },
  });

  console.log(`[publish] done. latest.json -> ${urlFor(remoteLatest)}`);
}

main().catch((e) => {
  console.error(`[publish] failed: ${e.message}`);
  process.exit(1);
});
