import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FilterSlice } from "@/store/types";

/**
 * 管理 GPU 交互预览和后端权威预览之间的交接。
 *
 * 拖动滑块或应用预设时，GPU 层先即时显示近似效果；
 * 后端 settled 预览完成前，继续保持 GPU 层，避免画面回跳或闪烁。
 */
export function useGpuPreviewHandoff({
  focusedId,
  canUseGpuInteractivePreview,
  filterIsIdentity,
  filterInteraction,
  gpuInteractiveReady,
  isAdjustingFilter,
  setFilterInteraction,
}: {
  focusedId: number | null;
  canUseGpuInteractivePreview: boolean;
  filterIsIdentity: boolean;
  filterInteraction: FilterSlice["filterInteraction"];
  gpuInteractiveReady: boolean;
  isAdjustingFilter: boolean;
  setFilterInteraction: (interaction: FilterSlice["filterInteraction"]) => void;
}) {
  const [gpuHandoffActive, setGpuHandoffActive] = useState(false);
  // 记录上一帧是否正在拖动，用于识别“刚松手”的瞬间。
  const wasAdjustingFilterRef = useRef(false);

  useLayoutEffect(() => {
    if (!canUseGpuInteractivePreview || filterIsIdentity) {
      setGpuHandoffActive(false);
      wasAdjustingFilterRef.current = isAdjustingFilter;
      return;
    }

    const finishedDragging = wasAdjustingFilterRef.current && !isAdjustingFilter;
    // preset_applied 会先走 GPU-only，随后进入 settling 等待后端权威图。
    const waitingForSettledPreview = filterInteraction === "settling";
    if ((finishedDragging || waitingForSettledPreview) && gpuInteractiveReady) {
      setGpuHandoffActive(true);
    }
    wasAdjustingFilterRef.current = isAdjustingFilter;
  }, [
    canUseGpuInteractivePreview,
    filterInteraction,
    filterIsIdentity,
    gpuInteractiveReady,
    isAdjustingFilter,
  ]);

  useEffect(() => {
    // 切换图片时所有交接状态都必须归零，防止上一张图的 GPU 层影响下一张图。
    setGpuHandoffActive(false);
    wasAdjustingFilterRef.current = false;
    setFilterInteraction("idle");
  }, [focusedId, setFilterInteraction]);

  return { gpuHandoffActive, setGpuHandoffActive };
}
