/** Natural cubic spline interpolation. */
export class CubicSpline {
  private xs: number[];
  private ys: number[];
  private ks: number[];

  constructor(xs: number[], ys: number[]) {
    this.xs = xs;
    this.ys = ys;
    this.ks = this._getNaturalKs();
  }

  private _getNaturalKs(): number[] {
    const n = this.xs.length - 1;
    const A: number[][] = Array.from({ length: n + 1 }, () => new Array(n + 2).fill(0));

    for (let i = 1; i < n; i++) {
      A[i][i - 1] = 1 / (this.xs[i] - this.xs[i - 1]);
      A[i][i] = 2 * (1 / (this.xs[i] - this.xs[i - 1]) + 1 / (this.xs[i + 1] - this.xs[i]));
      A[i][i + 1] = 1 / (this.xs[i + 1] - this.xs[i]);
      A[i][n + 1] =
        3 * (
          (this.ys[i] - this.ys[i - 1]) / ((this.xs[i] - this.xs[i - 1]) ** 2) +
          (this.ys[i + 1] - this.ys[i]) / ((this.xs[i + 1] - this.xs[i]) ** 2)
        );
    }

    A[0][0] = 2 / (this.xs[1] - this.xs[0]);
    A[0][1] = 1 / (this.xs[1] - this.xs[0]);
    A[0][n + 1] = 3 * (this.ys[1] - this.ys[0]) / ((this.xs[1] - this.xs[0]) ** 2);

    A[n][n - 1] = 1 / (this.xs[n] - this.xs[n - 1]);
    A[n][n] = 2 / (this.xs[n] - this.xs[n - 1]);
    A[n][n + 1] = 3 * (this.ys[n] - this.ys[n - 1]) / ((this.xs[n] - this.xs[n - 1]) ** 2);

    return this._gaussianElimination(A, n + 1);
  }

  private _gaussianElimination(A: number[][], n: number): number[] {
    for (let i = 0; i < n; i++) {
      let maxEl = Math.abs(A[i][i]);
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(A[k][i]) > maxEl) { maxEl = Math.abs(A[k][i]); maxRow = k; }
      }
      [A[maxRow], A[i]] = [A[i], A[maxRow]];
      for (let k = i + 1; k < n; k++) {
        const c = -A[k][i] / A[i][i];
        for (let j = i; j < n + 1; j++) {
          A[k][j] = j === i ? 0 : A[k][j] + c * A[i][j];
        }
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      x[i] = A[i][n] / A[i][i];
      for (let k = i - 1; k >= 0; k--) A[k][n] -= A[k][i] * x[i];
    }
    return x;
  }

  interpolate(x: number): number {
    const { xs, ys, ks } = this;
    let i = 1;
    while (i < xs.length - 1 && xs[i] < x) i++;
    const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    const a = ks[i - 1] * (xs[i] - xs[i - 1]) - (ys[i] - ys[i - 1]);
    const b = -ks[i] * (xs[i] - xs[i - 1]) + (ys[i] - ys[i - 1]);
    return (1 - t) * ys[i - 1] + t * ys[i] + t * (1 - t) * (a * (1 - t) + b * t);
  }

  drawPath(
    ctx: CanvasRenderingContext2D,
    toX: (x: number) => number,
    toY: (y: number) => number
  ): void {
    const { xs, ys, ks } = this;
    for (let i = 0; i < xs.length - 1; i++) {
      const h = xs[i + 1] - xs[i];
      const cp1x = toX(xs[i] + h / 3);
      const cp1y = toY(ys[i] + (ks[i] * h) / 3);
      const cp2x = toX(xs[i + 1] - h / 3);
      const cp2y = toY(ys[i + 1] - (ks[i + 1] * h) / 3);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, toX(xs[i + 1]), toY(ys[i + 1]));
    }
  }
}

/** Monotone cubic spline — Fritsch-Carlson method. Prevents overshoot. */
export class MonotonicCubicSpline {
  private xs: number[];
  private ys: number[];
  private ms: number[];

  constructor(xs: number[], ys: number[]) {
    this.xs = xs;
    this.ys = ys;
    this.ms = this._computeTangents();
  }

  private _computeTangents(): number[] {
    const n = this.xs.length;
    const delta: number[] = [];
    const m: number[] = new Array(n).fill(0);

    for (let i = 0; i < n - 1; i++) {
      delta[i] = (this.ys[i + 1] - this.ys[i]) / (this.xs[i + 1] - this.xs[i]);
    }

    m[0] = delta[0];
    for (let i = 1; i < n - 1; i++) m[i] = (delta[i - 1] + delta[i]) / 2;
    m[n - 1] = delta[n - 2];

    for (let i = 0; i < n - 1; i++) {
      if (delta[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / delta[i];
      const b = m[i + 1] / delta[i];
      const h = Math.sqrt(a * a + b * b);
      if (h > 3) { m[i] = (3 / h) * a * delta[i]; m[i + 1] = (3 / h) * b * delta[i]; }
    }
    return m;
  }

  interpolate(x: number): number {
    const { xs, ys, ms } = this;
    let i = xs.length - 2;
    for (let j = 0; j < xs.length - 1; j++) {
      if (x <= xs[j + 1]) { i = j; break; }
    }
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * ms[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * ms[i + 1]
    );
  }

  /**
   * Draw the spline as cubic bezier segments into an existing canvas path.
   * toX/toY convert spline coordinates to canvas coordinates.
   * Caller must call ctx.beginPath() and ctx.moveTo() before this.
   */
  drawPath(
    ctx: CanvasRenderingContext2D,
    toX: (x: number) => number,
    toY: (y: number) => number
  ): void {
    const { xs, ys, ms } = this;
    for (let i = 0; i < xs.length - 1; i++) {
      const h = xs[i + 1] - xs[i];
      // Cubic Hermite → Bezier control points
      const cp1x = toX(xs[i] + h / 3);
      const cp1y = toY(ys[i] + (ms[i] * h) / 3);
      const cp2x = toX(xs[i + 1] - h / 3);
      const cp2y = toY(ys[i + 1] - (ms[i + 1] * h) / 3);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, toX(xs[i + 1]), toY(ys[i + 1]));
    }
  }
}

const splines = { CubicSpline, MonotonicCubicSpline };
export default splines;
