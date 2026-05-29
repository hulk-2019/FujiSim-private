import type { CSSProperties } from "react";

export function isOrientationSwapped(orientation: number | null | undefined) {
  return orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8;
}

export function orientationTransform(orientation: number | null | undefined) {
  switch (orientation) {
    case 2:
      return "scaleX(-1)";
    case 3:
      return "rotate(180deg)";
    case 4:
      return "scaleY(-1)";
    case 5:
      return "rotate(90deg) scaleX(-1)";
    case 6:
      return "rotate(90deg)";
    case 7:
      return "rotate(270deg) scaleX(-1)";
    case 8:
      return "rotate(270deg)";
    default:
      return undefined;
  }
}

export function orientationCss(
  orientation: number | null | undefined,
): CSSProperties {
  const transform = orientationTransform(orientation);
  return transform ? { transform } : {};
}
