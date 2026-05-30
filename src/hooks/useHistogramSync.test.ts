import { describe, expect, it } from "vitest";
import { histogramErrorAction } from "@/hooks/useHistogramSync";

describe("histogramErrorAction", () => {
  it("retries preview_cancelled errors while the current request is still active", () => {
    expect(
      histogramErrorAction({
        currentToken: 12,
        focusedId: 3,
        message: "preview_cancelled",
        requestFocusedId: 3,
        requestToken: 12,
        retryCount: 0,
      }),
    ).toBe("retry");
  });

  it("ignores preview_cancelled errors from stale requests", () => {
    expect(
      histogramErrorAction({
        currentToken: 13,
        focusedId: 4,
        message: "preview_cancelled",
        requestFocusedId: 3,
        requestToken: 12,
        retryCount: 0,
      }),
    ).toBe("ignore");
  });
});
