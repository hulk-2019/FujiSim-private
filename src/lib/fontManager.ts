import { readFile } from "@tauri-apps/plugin-fs";
import type { UserFont } from "@/types";
import { api } from "@/api";

export function fontFamilyName(id: number): string {
  return `uf-${id}`;
}

const registeredIds = new Set<number>();

export async function registerFont(font: UserFont): Promise<void> {
  if (registeredIds.has(font.id)) return;
  registeredIds.add(font.id);

  const family = fontFamilyName(font.id);
  const bytes = await readFile(font.file_path);
  const fontFace = new FontFace(family, bytes);
  await fontFace.load();
  document.fonts.add(fontFace);
}

export function unregisterFont(id: number): void {
  registeredIds.delete(id);
  const family = fontFamilyName(id);
  for (const face of document.fonts) {
    if (face.family === `"${family}"` || face.family === family) {
      document.fonts.delete(face);
    }
  }
}

export async function loadPersistedFonts(): Promise<UserFont[]> {
  try {
    const fonts = await api.listUserFonts();
    await Promise.all(fonts.map(registerFont));
    return fonts;
  } catch {
    return [];
  }
}
