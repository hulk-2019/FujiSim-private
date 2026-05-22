import splines from "./splines";
import { PointCollection } from "./PointCollection";

type SplineType = "natural" | "monotonic";

type ControlPointState = "idle" | "hovered" | "grabbed";
type CurveState = "idle" | "moving";

interface ControlPointColor {
  idle: string;
  hovered: string;
  grabbed: string;
}

interface CurveColor {
  idle: string;
  moving: string;
}

type EventName = "movePoint" | "releasePoint" | "pointAdded" | "pointRemoved";
type EventCallback = (spliner: CanvasSpliner) => void;

interface OnEvents {
  movePoint: EventCallback | null;
  releasePoint: EventCallback | null;
  pointAdded: EventCallback | null;
  pointRemoved: EventCallback | null;
}

export class CanvasSpliner {

  private _controlPointRadius: number;
  private _controlPointColor: ControlPointColor;
  private _curveColor: CurveColor;
  private _gridColor: string;
  private _textColor: string;
  private _curveThickness: number;
  private _backgroundColor: string | false;
  private _mouse: { x: number; y: number } | null;
  private _pointHoveredIndex: number;
  private _pointGrabbedIndex: number;
  private _mouseDown: boolean;
  private _canvas: HTMLCanvasElement | null;
  private _ctx: CanvasRenderingContext2D | null;
  private _screenRatio: number;
  private _width: number;
  private _height: number;
  /** Point position at drag start, for axisLocked total-displacement calculation. */
  private _grabPointStart: { x: number; y: number; axisLocked?: boolean; anchor?: { x: number; y: number } } | null = null;
  private _splineConstructor: typeof splines.CubicSpline | typeof splines.MonotonicCubicSpline = splines.CubicSpline;
  private _pointCollection: PointCollection = new PointCollection();
  private _xSeriesInterpolated: Float32Array = new Float32Array(0);
  private _ySeriesInterpolated: Float32Array = new Float32Array(0);
  private _gridStep: number = 1 / 3;
  private _onEvents: OnEvents = { movePoint: null, releasePoint: null, pointAdded: null, pointRemoved: null };

  constructor(
    parentContainer: string | HTMLElement,
    width: number,
    height: number,
    splineType: SplineType = "natural"
  ) {
    this._controlPointRadius = 8;

    this._controlPointColor = {
      idle: "rgba(244, 66, 167, 0.5)",
      hovered: "rgba(0, 0, 255, 0.5)",
      grabbed: "rgba(0, 200, 0, 0.5)",
    };

    this._curveColor = {
      idle: "rgba(0, 128, 255, 1)",
      moving: "rgba(255, 128, 0, 1)",
    };

    this._gridColor = "rgba(0, 0, 0, 0.3)";
    this._textColor = "rgba(0, 0, 0, 0.1)";
    this._curveThickness = 1;
    this._backgroundColor = false;

    this._mouse = null;
    this._pointHoveredIndex = -1;
    this._pointGrabbedIndex = -1;
    this._mouseDown = false;

    this._canvas = null;
    this._ctx = null;

    this._screenRatio = window.devicePixelRatio;
    this._width = width;
    this._height = height;

    let parentElem: HTMLElement | null = null;
    if (typeof parentContainer === "string") {
      parentElem = document.getElementById(parentContainer);
    } else {
      parentElem = parentContainer;
    }

    if (!parentElem) return;

    this._canvas = document.createElement("canvas");
    this._canvas.width = width;
    this._canvas.height = height;
    this._canvas.setAttribute("tabIndex", "1");
    this._canvas.style.outline = "none";
    this._canvas.style.cursor = "default";
    this._canvas.style.border = "none";
    this._canvas.style.display = "block";
    this._canvas.style.width = "100%";
    this._canvas.style.height = "100%";
    this._canvas.style.userSelect = "none";
    this._canvas.style.webkitUserSelect = "none";
    this._canvas.onselectstart = () => false;

    parentElem.appendChild(this._canvas);

    this._ctx = this._canvas.getContext("2d");
    this._ctx!.scale(this._screenRatio, this._screenRatio);

    this._canvas.addEventListener("mousemove", this._onCanvasMouseMove.bind(this), false);
    this._canvas.addEventListener("mousedown", this._onCanvasMouseDown.bind(this), false);
    window.addEventListener("mouseup", this._onCanvasMouseUp.bind(this), false);
    this._canvas.addEventListener("dblclick", this._onCanvasMouseDbclick.bind(this), false);
    this._canvas.addEventListener("mouseleave", this._onCanvasMouseLeave.bind(this), false);
    this._canvas.addEventListener("mouseenter", this._onCanvasMouseEnter.bind(this), false);
    this._canvas.addEventListener("keyup", this._onKeyUp.bind(this), false);

    this._splineConstructor = splines.CubicSpline;
    if (splineType === "monotonic") {
      this._splineConstructor = splines.MonotonicCubicSpline;
    }

    this._pointCollection = new PointCollection();
    this._pointCollection.setBoundary("max", "x", width);
    this._pointCollection.setBoundary("max", "y", height);

    this._xSeriesInterpolated = new Float32Array(this._width).fill(0);
    this._ySeriesInterpolated = new Float32Array(this._width).fill(0);

    this._gridStep = 1 / 3;

    this._onEvents = {
      movePoint: null,
      releasePoint: null,
      pointAdded: null,
      pointRemoved: null,
    };

    this.draw();
  }

  getXSeriesInterpolated(): Float32Array {
    return this._xSeriesInterpolated;
  }

  getYSeriesInterpolated(): Float32Array {
    return this._ySeriesInterpolated;
  }

  setControlPointRadius(r: number): void {
    this._controlPointRadius = r;
  }

  setControlPointColor(state: ControlPointState, color: string): void {
    this._controlPointColor[state] = color;
  }

  setCurveColor(state: CurveState, color: string): void {
    this._curveColor[state] = color;
  }

  setGridColor(color: string): void {
    this._gridColor = color;
  }

  setGridStep(gs: number): void {
    this._gridStep = gs <= 0 || gs >= 1 ? 0 : gs;
    this.draw();
  }

  setTextColor(color: string): void {
    this._textColor = color;
  }

  setCurveThickness(t: number): void {
    this._curveThickness = t;
  }

  setBackgroundColor(color: string | false): void {
    this._backgroundColor = color;
  }

  setSplineType(splineType: SplineType): void {
    this._splineConstructor =
      splineType === "monotonic" ? splines.MonotonicCubicSpline : splines.CubicSpline;
  }

  private _updateMousePosition(evt: MouseEvent): void {
    const rect = this._canvas!.getBoundingClientRect();
    const scaleX = this._width / rect.width;
    const scaleY = this._height / rect.height;
    const px = (evt.clientX - rect.left) * scaleX;
    const py = (evt.clientY - rect.top) * scaleY;
    this._mouse = {
      x: Math.max(0, Math.min(this._width, px)),
      y: Math.max(0, Math.min(this._height, this._height - py)),
    };
  }

  private _onCanvasMouseMove(evt: MouseEvent): void {
    this._updateMousePosition(evt);

    const closestPointInfo = this._pointCollection.getClosestFrom(this._mouse!);
    if (!closestPointInfo) return;

    if (this._pointGrabbedIndex === -1) {
      if (closestPointInfo.distance <= this._controlPointRadius * 2) {
        this._pointHoveredIndex = closestPointInfo.index;
      } else {
        const mustRedraw = this._pointHoveredIndex !== -1;
        this._pointHoveredIndex = -1;
        if (mustRedraw) this.draw();
      }
    } else {
      let target = { ...this._mouse! };

      if (this._grabPointStart?.axisLocked && this._grabPointStart.anchor) {
        const anchor = this._grabPointStart.anchor;
        // Axis decision: based on which edge the mouse is closer to (anchor.x edge or anchor.y edge)
        // Distance from cursor to vertical edge (x = anchor.x) vs horizontal edge (y = anchor.y)
        const distToVerticalEdge = Math.abs(target.x - anchor.x);
        const distToHorizontalEdge = Math.abs(target.y - anchor.y);
        if (distToVerticalEdge <= distToHorizontalEdge) {
          // Closer to vertical edge → snap onto it (lock x to anchor.x), free y
          target.x = anchor.x;
        } else {
          // Closer to horizontal edge → snap onto it (lock y to anchor.y), free x
          target.y = anchor.y;
        }
      }

      this._pointGrabbedIndex = this._pointCollection.updatePoint(
        this._pointGrabbedIndex,
        target
      );
      this._pointHoveredIndex = this._pointGrabbedIndex;
    }

    if (this._pointHoveredIndex !== -1 || this._pointGrabbedIndex !== -1) {
      this.draw();
    }

    if (this._pointGrabbedIndex !== -1) {
      const grabbedPoint = this._pointCollection.getPoint(this._pointGrabbedIndex);
      if (grabbedPoint) {
        this._drawCoordinates(
          Math.round((grabbedPoint.x / this._width) * 1000) / 1000,
          Math.round((grabbedPoint.y / this._height) * 1000) / 1000
        );
      }
      if (this._onEvents.movePoint) this._onEvents.movePoint(this);
    }
  }

  private _onCanvasMouseDown(evt: MouseEvent): void {
    evt.preventDefault();
    this._mouseDown = true;
    this._updateMousePosition(evt);
    if (this._pointHoveredIndex !== -1) {
      this._pointGrabbedIndex = this._pointHoveredIndex;
      const pt = this._pointCollection.getPoint(this._pointHoveredIndex);
      this._grabPointStart = pt ? { x: pt.x, y: pt.y, axisLocked: pt.axisLocked, anchor: pt.anchor } : null;
    }
  }

  private _onCanvasMouseUp(_evt: MouseEvent): void {
    const aPointWasGrabbed = this._pointGrabbedIndex !== -1;
    this._mouseDown = false;
    this._pointGrabbedIndex = -1;
    this._grabPointStart = null;
    this.draw();
    if (this._onEvents.releasePoint && aPointWasGrabbed) this._onEvents.releasePoint(this);
  }

  private _onCanvasMouseDbclick(evt: MouseEvent): void {
    evt.preventDefault();
    this._canvas!.focus();
    if (this._pointHoveredIndex === -1) {
      const index = this.add({
        x: this._mouse!.x / this._width,
        y: this._mouse!.y / this._height,
      });
      this._pointHoveredIndex = index ?? -1;
    } else {
      this.remove(this._pointHoveredIndex);
      this._pointHoveredIndex = -1;
      this._pointGrabbedIndex = -1;
    }
  }

  private _onCanvasMouseLeave(_evt: MouseEvent): void {
    this.draw();
  }

  private _onCanvasMouseEnter(_evt: MouseEvent): void {
    this._canvas!.focus();
  }

  private _onKeyUp(evt: KeyboardEvent): void {
    if (!this._mouse) return;
    if (evt.key === "d") this.remove(this._pointHoveredIndex);
  }

  add(pt: { x: number; y: number; xLocked?: boolean; yLocked?: boolean; safe?: boolean; axisLocked?: boolean; anchor?: { x: number; y: number } }, draw = true): number | null {
    let index: number | null = null;
    if ("x" in pt && "y" in pt) {
      pt.x *= this._width;
      pt.y *= this._height;
      // anchor is also normalized — denormalize to pixel coords
      if (pt.anchor) {
        pt.anchor = { x: pt.anchor.x * this._width, y: pt.anchor.y * this._height };
      }
      index = this._pointCollection.add(pt);
    }
    if (draw) this.draw();
    if (this._onEvents.pointAdded) this._onEvents.pointAdded(this);
    return index;
  }

  remove(index: number): void {
    this._pointCollection.remove(index);
    this.draw();
    if (this._onEvents.pointRemoved) this._onEvents.pointRemoved(this);
  }

  /** Clear all points and reload the given normalized points without firing events. */
  resetPoints(pts: Array<{ x: number; y: number; xLocked?: boolean; yLocked?: boolean; safe?: boolean; axisLocked?: boolean; anchor?: { x: number; y: number } }>): void {
    this._pointCollection.clear();
    for (const pt of pts) {
      this.add({ ...pt }, false);
    }
    this.draw();
  }

  draw(): void {
    if (!this._ctx) return;
    this._ctx.clearRect(0, 0, this._width, this._height);
    this._fillBackground();
    this._drawGrid();
    this._drawData();
  }

  private _fillBackground(): void {
    if (!this._backgroundColor || !this._ctx) return;
    this._ctx.beginPath();
    this._ctx.rect(0, 0, this._width, this._height);
    this._ctx.fillStyle = this._backgroundColor;
    this._ctx.fill();
  }

  private _drawCoordinates(x: number, y: number): void {
    if (!this._ctx) return;
    const textSize = 14 / this._screenRatio;
    this._ctx.fillStyle = this._textColor;
    this._ctx.font = `${textSize}px courier`;
    this._ctx.fillText("x: " + x, 10 / this._screenRatio, 20 / this._screenRatio);
    this._ctx.fillText("y: " + y, 10 / this._screenRatio, 35 / this._screenRatio);
  }

  private _drawGrid(): void {
    if (!this._ctx || this._gridStep === 0) return;
    const step = this._gridStep;

    this._ctx.beginPath();
    for (
      let i = (step * this._height) / this._screenRatio;
      i < this._height / this._screenRatio;
      i += (step * this._height) / this._screenRatio
    ) {
      this._ctx.moveTo(0, Math.round(i) + 0.5 / this._screenRatio);
      this._ctx.lineTo(this._width, Math.round(i) + 0.5 / this._screenRatio);
    }
    for (
      let i = (step * this._width) / this._screenRatio;
      i < this._width / this._screenRatio;
      i += (step * this._width) / this._screenRatio
    ) {
      this._ctx.moveTo(Math.round(i) + 0.5 / this._screenRatio, 0);
      this._ctx.lineTo(Math.round(i) + 0.5 / this._screenRatio, this._height);
    }
    this._ctx.strokeStyle = this._gridColor;
    this._ctx.lineWidth = 0.5;
    this._ctx.stroke();
    this._ctx.closePath();
  }

  private _drawData(curve = true, control = true): void {
    if (!this._ctx) return;
    const xSeries = this._pointCollection.getXseries();
    const ySeries = this._pointCollection.getYseries();
    const w = this._width;
    const h = this._height;

    if (!xSeries.length) return;

    if (curve) {
      const toX = (x: number) => x / this._screenRatio;
      const toY = (y: number) => (h - y) / this._screenRatio;

      this._ctx.beginPath();

      // Fill interpolated buffer (still needed for getValue / getYSeriesInterpolated)
      const splineInterpolator = new this._splineConstructor(xSeries, ySeries);
      this._xSeriesInterpolated.fill(0);
      this._ySeriesInterpolated.fill(0);
      for (let x = 0; x < w; x++) {
        let y: number;
        if (x < xSeries[0]) y = ySeries[0];
        else if (x >= xSeries[xSeries.length - 1]) y = ySeries[ySeries.length - 1];
        else y = splineInterpolator.interpolate(x);
        this._xSeriesInterpolated[x] = x / w;
        this._ySeriesInterpolated[x] = Math.max(0, Math.min(1, y / h));
      }

      // Draw using bezier curves for perfect smoothness at any resolution
      this._ctx.moveTo(toX(xSeries[0]), toY(ySeries[0]));

      // Bezier segments between control points
      splineInterpolator.drawPath(this._ctx, toX, toY);

      this._ctx.strokeStyle =
        this._pointGrabbedIndex === -1 ? this._curveColor.idle : this._curveColor.moving;
      this._ctx.lineWidth = this._curveThickness / this._screenRatio;
      this._ctx.stroke();
      this._ctx.closePath();
    }

    if (control) {
      for (let i = 0; i < xSeries.length; i++) {
        this._ctx.beginPath();
        this._ctx.arc(
          xSeries[i] / this._screenRatio,
          (h - ySeries[i]) / this._screenRatio,
          this._controlPointRadius / this._screenRatio,
          0,
          2 * Math.PI
        );

        if (this._pointHoveredIndex === -1) {
          this._ctx.fillStyle = this._controlPointColor.idle;
        } else if (i === this._pointHoveredIndex) {
          this._ctx.fillStyle = this._mouseDown
            ? this._controlPointColor.grabbed
            : this._controlPointColor.hovered;
        } else {
          this._ctx.fillStyle = this._controlPointColor.idle;
        }

        this._ctx.fill();
        this._ctx.closePath();
      }
    }
  }

  getValue(x: number): number {
    const xSeries = this._pointCollection.getXseries();
    const ySeries = this._pointCollection.getYseries();

    if (x <= xSeries[0] / this._width) return ySeries[0] / this._height;
    if (x >= xSeries[xSeries.length - 1] / this._width) return ySeries[ySeries.length - 1] / this._height;

    const splineInterpolator = new this._splineConstructor(xSeries, ySeries);
    return splineInterpolator.interpolate(x * this._width) / this._height;
  }

  on(eventName: EventName, callback: EventCallback): void {
    this._onEvents[eventName] = callback;
  }

  /** Return the user's control points as normalized [0,1] coordinates. */
  getControlPoints(): Array<{ x: number; y: number }> {
    const xs = this._pointCollection.getXseries();
    const ys = this._pointCollection.getYseries();
    return xs.map((x, i) => ({ x: x / this._width, y: ys[i] / this._height }));
  }

  /** Remove all event listeners attached to the canvas (call before unmounting). */
  destroy(): void {
    if (!this._canvas) return;
    window.removeEventListener("mouseup", this._onCanvasMouseUp.bind(this));
    this._canvas.remove();
    this._canvas = null;
    this._ctx = null;
  }
}
