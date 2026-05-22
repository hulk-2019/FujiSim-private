export interface Point {
  x: number;
  y: number;
  xLocked?: boolean;
  yLocked?: boolean;
  safe?: boolean;
  /** When true, dragging is constrained to the dominant axis (horizontal or vertical). */
  axisLocked?: boolean;
  /** Anchor corner (in canvas pixel coords). When axisLocked, the orthogonal axis snaps to this anchor's value. */
  anchor?: { x: number; y: number };
}

interface Boundary {
  x: number;
  y: number;
}

interface ClosestResult {
  index: number;
  distance: number;
}

export class PointCollection {
  private _points: Point[];
  private _min: Boundary;
  private _max: Boundary;

  constructor() {
    this._points = [];
    this._min = { x: 0, y: 0 };
    this._max = { x: Infinity, y: Infinity };
  }

  setBoundary(bound: "min" | "max", axis: "x" | "y", value: number): void {
    if (bound === "min") this._min[axis] = value;
    else this._max[axis] = value;
  }

  add(p: Point): number | null {
    let newIndex: number | null = null;

    if (
      p.x >= this._min.x && p.x <= this._max.x &&
      p.y >= this._min.y && p.y <= this._max.y
    ) {
      if (!("xLocked" in p)) p.xLocked = false;
      if (!("yLocked" in p)) p.yLocked = false;
      if (!("safe" in p)) p.safe = false;
      if (!("axisLocked" in p)) p.axisLocked = false;

      this._points.push(p);
      this._sortPoints();
      newIndex = this._points.indexOf(p);
    }
    return newIndex;
  }

  private _sortPoints(): void {
    this._points.sort((p1, p2) => p1.x - p2.x);
  }

  remove(index: number): Point[] | null {
    let removedPoint: Point[] | null = null;
    if (index >= 0 && index < this._points.length && !this._points[index].safe) {
      removedPoint = this._points.splice(index, 1);
    }
    return removedPoint;
  }

  getClosestFrom(p: { x: number; y: number }): ClosestResult | null {
    if (!this._points.length) return null;

    let closestDistance = Infinity;
    let closestPointIndex: number | null = null;

    for (let i = 0; i < this._points.length; i++) {
      const d = Math.sqrt(
        Math.pow(p.x - this._points[i].x, 2) +
        Math.pow(p.y - this._points[i].y, 2)
      );
      if (d < closestDistance) {
        closestDistance = d;
        closestPointIndex = i;
      }
    }

    return { index: closestPointIndex!, distance: closestDistance };
  }

  getPoint(index: number): Point | null {
    if (index >= 0 && index < this._points.length) return this._points[index];
    return null;
  }

  getNumberOfPoints(): number {
    return this._points.length;
  }

  clear(): void {
    this._points = [];
  }

  updatePoint(index: number, p: { x: number; y: number }): number {
    let newIndex = index;

    if (index >= 0 && index < this._points.length) {
      if (
        p.x >= this._min.x && p.x <= this._max.x &&
        p.y >= this._min.y && p.y <= this._max.y
      ) {
        const pt = this._points[index];

        // Prevent x from crossing or touching neighboring points (keep 1px min gap)
        let newX = p.x;
        const left = index > 0 ? this._points[index - 1] : null;
        const right = index < this._points.length - 1 ? this._points[index + 1] : null;
        if (left && newX <= left.x) newX = left.x + 1;
        if (right && newX >= right.x) newX = right.x - 1;

        if (!pt.xLocked) pt.x = newX;
        if (!pt.yLocked) pt.y = p.y;

        this._sortPoints();
        newIndex = this._points.indexOf(pt);
      }
    }
    return newIndex;
  }

  getXseries(): number[] {
    return this._points.map((p) => p.x);
  }

  getYseries(): number[] {
    return this._points.map((p) => p.y);
  }
}
