import * as THREE from "three";

import type { Dxf2DFeatureModel, Vec2 } from "./dxf-preview-feature-model";
import type {
  DxfDimensionPlacementSide,
  DxfPreviewDimension,
} from "./dxf-preview-dimensions";
import type { Viewer } from "./viewer";

const SVG_NS = "http://www.w3.org/2000/svg";
const LABEL_FONT_FAMILY = "'SF Mono', 'Menlo', 'Consolas', monospace";
const DIMENSION_LANE_OFFSETS = [18, 34, 50] as const;
const ALL_SIDES: DxfDimensionPlacementSide[] = ["top", "bottom", "right", "left"];

export type DxfPreviewOverlayViewer = Pick<
  Viewer,
  "projectWorldToScreen" | "getRendererSize"
>;

export type DxfPreviewDimensionStyle = {
  strokeColor: string;
  textColor: string;
  strokeWidth: number;
  arrowSize: number;
  fontSize: number;
  extensionGap: number;
  extensionLength: number;
  labelOffset: number;
  labelPadding: number;
  collisionNudge: number;
  maxLabelNudges: number;
};

export const DXF_PREVIEW_DIMENSION_STYLE_DEFAULTS: DxfPreviewDimensionStyle = {
  strokeColor: "#1f2937",
  textColor: "#111827",
  strokeWidth: 1.25,
  arrowSize: 7,
  fontSize: 11.5,
  extensionGap: 6,
  extensionLength: 14,
  labelOffset: 10,
  labelPadding: 4,
  collisionNudge: 14,
  maxLabelNudges: 7,
};

export type DxfPreviewOverlayLine = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type DxfPreviewOverlayArrow = {
  tipX: number;
  tipY: number;
  dirX: number;
  dirY: number;
};

export type DxfPreviewOverlayLabel = {
  x: number;
  y: number;
  text: string;
  box: { x: number; y: number; width: number; height: number };
  priority: number;
};

export type DxfPreviewOverlayPrimitives = {
  lines: DxfPreviewOverlayLine[];
  arrows: DxfPreviewOverlayArrow[];
  labels: DxfPreviewOverlayLabel[];
  size: { width: number; height: number };
  style: DxfPreviewDimensionStyle;
};

type ScreenPoint = { x: number; y: number };
type LabelSize = { width: number; height: number };
type LabelMeasureFn = (text: string, fontSize: number) => LabelSize;
type Box = { x: number; y: number; width: number; height: number };

type SilhouetteProjection = {
  points: ScreenPoint[];
  box: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
};

type PreparedLinear = {
  p1: ScreenPoint;
  p2: ScreenPoint;
  axis: ScreenPoint;
};

type PreparedDiameter = {
  center: ScreenPoint;
  anchors: ScreenPoint[];
};

type DimensionCandidate = {
  lines: DxfPreviewOverlayLine[];
  arrows: DxfPreviewOverlayArrow[];
  label: DxfPreviewOverlayLabel;
};

function mergeStyle(
  style?: Partial<DxfPreviewDimensionStyle>,
): DxfPreviewDimensionStyle {
  return { ...DXF_PREVIEW_DIMENSION_STYLE_DEFAULTS, ...(style ?? {}) };
}

function vecLength(x: number, y: number): number {
  return Math.hypot(x, y);
}

function normalize2D(x: number, y: number): { x: number; y: number } {
  const len = vecLength(x, y);
  if (len <= 1e-9) return { x: 1, y: 0 };
  return { x: x / len, y: y / len };
}

function dot2(a: ScreenPoint, b: ScreenPoint): number {
  return a.x * b.x + a.y * b.y;
}

function local2DToWorld(point: Vec2, previewRoot: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3(point.x, 0, point.y).applyMatrix4(previewRoot.matrixWorld);
}

function projectLocalPoint(params: {
  viewer: DxfPreviewOverlayViewer;
  previewRoot: THREE.Object3D;
  local: Vec2;
}): ScreenPoint | null {
  const world = local2DToWorld(params.local, params.previewRoot);
  const projected = params.viewer.projectWorldToScreen(world);
  if (!projected.visible) return null;
  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;
  return { x: projected.x, y: projected.y };
}

function projectLocalDirection(params: {
  viewer: DxfPreviewOverlayViewer;
  previewRoot: THREE.Object3D;
  originLocal: Vec2;
  directionLocal: Vec2;
}): ScreenPoint | null {
  const directionLen = Math.hypot(params.directionLocal.x, params.directionLocal.y);
  if (!Number.isFinite(directionLen) || directionLen <= 1e-9) return null;
  const originWorld = local2DToWorld(params.originLocal, params.previewRoot);
  const targetWorld = local2DToWorld(
    {
      x: params.originLocal.x + params.directionLocal.x,
      y: params.originLocal.y + params.directionLocal.y,
    },
    params.previewRoot,
  );
  const originScreen = params.viewer.projectWorldToScreen(originWorld);
  const targetScreen = params.viewer.projectWorldToScreen(targetWorld);
  if (!originScreen.visible || !targetScreen.visible) return null;
  const dx = targetScreen.x - originScreen.x;
  const dy = targetScreen.y - originScreen.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const len = Math.hypot(dx, dy);
  if (len <= 1e-6) return null;
  return { x: dx / len, y: dy / len };
}

function fallbackLabelMeasure(text: string, fontSize: number): LabelSize {
  return {
    width: text.length * fontSize * 0.62,
    height: fontSize,
  };
}

function boxFromCenter(
  x: number,
  y: number,
  size: LabelSize,
  style: DxfPreviewDimensionStyle,
): Box {
  const width = Math.max(1, size.width + style.labelPadding * 2);
  const height = Math.max(1, size.height + style.labelPadding * 2);
  return {
    x: x - width / 2,
    y: y - height / 2,
    width,
    height,
  };
}

function boxesOverlap(a: Box, b: Box): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function isBoxInsideViewport(
  box: Box,
  width: number,
  height: number,
): boolean {
  const margin = 2;
  return (
    box.x >= margin &&
    box.y >= margin &&
    box.x + box.width <= width - margin &&
    box.y + box.height <= height - margin
  );
}

function sideVector(side: DxfDimensionPlacementSide): ScreenPoint {
  switch (side) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
  }
}

function uniqueSideOrder(hints: DxfDimensionPlacementSide[]): DxfDimensionPlacementSide[] {
  const ordered: DxfDimensionPlacementSide[] = [];
  const seen = new Set<DxfDimensionPlacementSide>();
  for (const side of hints) {
    if (seen.has(side)) continue;
    seen.add(side);
    ordered.push(side);
  }
  for (const side of ALL_SIDES) {
    if (seen.has(side)) continue;
    seen.add(side);
    ordered.push(side);
  }
  return ordered;
}

function projectSilhouette(params: {
  viewer: DxfPreviewOverlayViewer;
  previewRoot: THREE.Object3D;
  featureModel: Dxf2DFeatureModel;
}): SilhouetteProjection | null {
  const projected: ScreenPoint[] = [];
  const sourcePoints =
    params.featureModel.outerOutline?.points ??
    [
      { x: params.featureModel.bounds.minX, y: params.featureModel.bounds.minY },
      { x: params.featureModel.bounds.maxX, y: params.featureModel.bounds.minY },
      { x: params.featureModel.bounds.maxX, y: params.featureModel.bounds.maxY },
      { x: params.featureModel.bounds.minX, y: params.featureModel.bounds.maxY },
    ];

  for (const point of sourcePoints) {
    const screen = projectLocalPoint({
      viewer: params.viewer,
      previewRoot: params.previewRoot,
      local: point,
    });
    if (!screen) continue;
    projected.push(screen);
  }

  if (projected.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of projected) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return null;
  }

  return {
    points: projected,
    box: { minX, maxX, minY, maxY },
  };
}

function silhouetteLabelCollisionBox(silhouette: SilhouetteProjection): Box {
  return {
    x: silhouette.box.minX,
    y: silhouette.box.minY,
    width: Math.max(1, silhouette.box.maxX - silhouette.box.minX),
    height: Math.max(1, silhouette.box.maxY - silhouette.box.minY),
  };
}

function pointFromBasis(axis: ScreenPoint, outward: ScreenPoint, t: number, n: number): ScreenPoint {
  return {
    x: axis.x * t + outward.x * n,
    y: axis.y * t + outward.y * n,
  };
}

function prepareLinearDimension(params: {
  dimension: Extract<DxfPreviewDimension, { type: "linear" }>;
  viewer: DxfPreviewOverlayViewer;
  previewRoot: THREE.Object3D;
}): PreparedLinear | null {
  const p1 = projectLocalPoint({
    viewer: params.viewer,
    previewRoot: params.previewRoot,
    local: params.dimension.p1Local,
  });
  const p2 = projectLocalPoint({
    viewer: params.viewer,
    previewRoot: params.previewRoot,
    local: params.dimension.p2Local,
  });
  if (!p1 || !p2) return null;

  const axis =
    projectLocalDirection({
      viewer: params.viewer,
      previewRoot: params.previewRoot,
      originLocal: params.dimension.p1Local,
      directionLocal: params.dimension.axisLocal,
    }) ?? normalize2D(p2.x - p1.x, p2.y - p1.y);

  return { p1, p2, axis };
}

function prepareDiameterDimension(params: {
  dimension: Extract<DxfPreviewDimension, { type: "diameter" }>;
  viewer: DxfPreviewOverlayViewer;
  previewRoot: THREE.Object3D;
}): PreparedDiameter | null {
  const center = projectLocalPoint({
    viewer: params.viewer,
    previewRoot: params.previewRoot,
    local: params.dimension.centerLocal,
  });
  if (!center) return null;

  const offsets: Vec2[] = [
    { x: params.dimension.radiusLocal, y: 0 },
    { x: -params.dimension.radiusLocal, y: 0 },
    { x: 0, y: params.dimension.radiusLocal },
    { x: 0, y: -params.dimension.radiusLocal },
  ];
  const anchors: ScreenPoint[] = [];
  for (const offset of offsets) {
    const anchor = projectLocalPoint({
      viewer: params.viewer,
      previewRoot: params.previewRoot,
      local: {
        x: params.dimension.centerLocal.x + offset.x,
        y: params.dimension.centerLocal.y + offset.y,
      },
    });
    if (!anchor) continue;
    anchors.push(anchor);
  }
  if (anchors.length === 0) return null;

  return { center, anchors };
}

function buildLinearCandidate(params: {
  dimension: Extract<DxfPreviewDimension, { type: "linear" }>;
  prepared: PreparedLinear;
  side: DxfDimensionPlacementSide;
  laneOffset: number;
  silhouette: SilhouetteProjection;
  style: DxfPreviewDimensionStyle;
  measureLabel: LabelMeasureFn;
}): DimensionCandidate | null {
  const axis = normalize2D(params.prepared.axis.x, params.prepared.axis.y);
  const requestedOutward = sideVector(params.side);
  const outwardRaw = {
    x: requestedOutward.x - axis.x * (axis.x * requestedOutward.x + axis.y * requestedOutward.y),
    y: requestedOutward.y - axis.y * (axis.x * requestedOutward.x + axis.y * requestedOutward.y),
  };
  const outwardLen = Math.hypot(outwardRaw.x, outwardRaw.y);
  if (outwardLen <= 1e-6) return null;
  let outward = { x: outwardRaw.x / outwardLen, y: outwardRaw.y / outwardLen };
  if (outward.x * requestedOutward.x + outward.y * requestedOutward.y < 0) {
    outward = { x: -outward.x, y: -outward.y };
  }

  const t1 = dot2(params.prepared.p1, axis);
  const t2 = dot2(params.prepared.p2, axis);
  const n1 = dot2(params.prepared.p1, outward);
  const n2 = dot2(params.prepared.p2, outward);
  const silNMax = params.silhouette.points.reduce(
    (maxValue, point) => Math.max(maxValue, dot2(point, outward)),
    Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(silNMax)) return null;

  const targetN = silNMax + params.laneOffset;
  const ext1Start = pointFromBasis(axis, outward, t1, n1 + params.style.extensionGap);
  const ext2Start = pointFromBasis(axis, outward, t2, n2 + params.style.extensionGap);
  const ext1End = pointFromBasis(axis, outward, t1, targetN);
  const ext2End = pointFromBasis(axis, outward, t2, targetN);

  const labelCenter = {
    x: (ext1End.x + ext2End.x) * 0.5 + outward.x * params.style.labelOffset,
    y: (ext1End.y + ext2End.y) * 0.5 + outward.y * params.style.labelOffset,
  };
  const labelSize = params.measureLabel(params.dimension.valueText, params.style.fontSize);
  const labelBox = boxFromCenter(labelCenter.x, labelCenter.y, labelSize, params.style);

  return {
    lines: [
      { x1: ext1Start.x, y1: ext1Start.y, x2: ext1End.x, y2: ext1End.y },
      { x1: ext2Start.x, y1: ext2Start.y, x2: ext2End.x, y2: ext2End.y },
      { x1: ext1End.x, y1: ext1End.y, x2: ext2End.x, y2: ext2End.y },
    ],
    arrows: [
      {
        tipX: ext1End.x,
        tipY: ext1End.y,
        dirX: axis.x,
        dirY: axis.y,
      },
      {
        tipX: ext2End.x,
        tipY: ext2End.y,
        dirX: -axis.x,
        dirY: -axis.y,
      },
    ],
    label: {
      x: labelCenter.x,
      y: labelCenter.y,
      text: params.dimension.valueText,
      box: labelBox,
      priority: params.dimension.priority,
    },
  };
}

function pickDiameterAnchor(params: {
  center: ScreenPoint;
  anchors: ScreenPoint[];
  side: DxfDimensionPlacementSide;
}): ScreenPoint | null {
  const sideDir = sideVector(params.side);
  let best: ScreenPoint | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const anchor of params.anchors) {
    const radial = normalize2D(anchor.x - params.center.x, anchor.y - params.center.y);
    const score = radial.x * sideDir.x + radial.y * sideDir.y;
    if (score > bestScore) {
      best = anchor;
      bestScore = score;
    }
  }
  return best;
}

function buildDiameterCandidate(params: {
  dimension: Extract<DxfPreviewDimension, { type: "diameter" }>;
  prepared: PreparedDiameter;
  side: DxfDimensionPlacementSide;
  laneOffset: number;
  silhouette: SilhouetteProjection;
  style: DxfPreviewDimensionStyle;
  measureLabel: LabelMeasureFn;
}): DimensionCandidate | null {
  const anchor = pickDiameterAnchor({
    center: params.prepared.center,
    anchors: params.prepared.anchors,
    side: params.side,
  });
  if (!anchor) return null;

  const sideDir = sideVector(params.side);
  const elbow = {
    x: anchor.x + sideDir.x * params.style.extensionLength,
    y: anchor.y + sideDir.y * params.style.extensionLength,
  };

  const laneX =
    params.side === "left"
      ? params.silhouette.box.minX - params.laneOffset
      : params.side === "right"
        ? params.silhouette.box.maxX + params.laneOffset
        : elbow.x;
  const laneY =
    params.side === "top"
      ? params.silhouette.box.minY - params.laneOffset
      : params.side === "bottom"
        ? params.silhouette.box.maxY + params.laneOffset
        : elbow.y;

  const labelCenter = { x: laneX, y: laneY };
  const labelSize = params.measureLabel(params.dimension.valueText, params.style.fontSize);
  const labelBox = boxFromCenter(labelCenter.x, labelCenter.y, labelSize, params.style);

  return {
    lines: [
      { x1: anchor.x, y1: anchor.y, x2: elbow.x, y2: elbow.y },
      { x1: elbow.x, y1: elbow.y, x2: labelCenter.x, y2: labelCenter.y },
    ],
    arrows: [
      {
        tipX: anchor.x,
        tipY: anchor.y,
        dirX: params.prepared.center.x - anchor.x,
        dirY: params.prepared.center.y - anchor.y,
      },
    ],
    label: {
      x: labelCenter.x,
      y: labelCenter.y,
      text: params.dimension.valueText,
      box: labelBox,
      priority: params.dimension.priority,
    },
  };
}

function buildCandidate(params: {
  dimension: DxfPreviewDimension;
  side: DxfDimensionPlacementSide;
  laneOffset: number;
  viewer: DxfPreviewOverlayViewer;
  previewRoot: THREE.Object3D;
  silhouette: SilhouetteProjection;
  style: DxfPreviewDimensionStyle;
  measureLabel: LabelMeasureFn;
}): DimensionCandidate | null {
  if (params.dimension.type === "linear") {
    const prepared = prepareLinearDimension({
      dimension: params.dimension,
      viewer: params.viewer,
      previewRoot: params.previewRoot,
    });
    if (!prepared) return null;
    return buildLinearCandidate({
      dimension: params.dimension,
      prepared,
      side: params.side,
      laneOffset: params.laneOffset,
      silhouette: params.silhouette,
      style: params.style,
      measureLabel: params.measureLabel,
    });
  }

  const prepared = prepareDiameterDimension({
    dimension: params.dimension,
    viewer: params.viewer,
    previewRoot: params.previewRoot,
  });
  if (!prepared) return null;
  return buildDiameterCandidate({
    dimension: params.dimension,
    prepared,
    side: params.side,
    laneOffset: params.laneOffset,
    silhouette: params.silhouette,
    style: params.style,
    measureLabel: params.measureLabel,
  });
}

function createTwoPassLabelMeasurer(
  svg: SVGSVGElement,
  style: DxfPreviewDimensionStyle,
  dimensions: DxfPreviewDimension[],
): LabelMeasureFn {
  const uniqueTexts = new Set<string>();
  for (const dim of dimensions) {
    uniqueTexts.add(dim.valueText);
  }

  if (uniqueTexts.size === 0) {
    return fallbackLabelMeasure;
  }

  const measuredByText = new Map<string, LabelSize>();
  const measureGroup = createSvgElement("g");
  measureGroup.setAttribute("opacity", "0");
  measureGroup.setAttribute("pointer-events", "none");
  svg.appendChild(measureGroup);

  for (const textValue of uniqueTexts) {
    const textNode = createSvgElement("text");
    textNode.setAttribute("x", "0");
    textNode.setAttribute("y", "0");
    textNode.setAttribute("font-size", `${style.fontSize}`);
    textNode.setAttribute("font-family", LABEL_FONT_FAMILY);
    textNode.setAttribute("text-anchor", "middle");
    textNode.setAttribute("dominant-baseline", "middle");
    textNode.textContent = textValue;
    measureGroup.appendChild(textNode);

    let measured: LabelSize | null = null;
    try {
      const box = textNode.getBBox();
      if (Number.isFinite(box.width) && Number.isFinite(box.height)) {
        measured = {
          width: Math.max(1, box.width),
          height: Math.max(1, box.height),
        };
      }
    } catch {
      measured = null;
    }
    measuredByText.set(textValue, measured ?? fallbackLabelMeasure(textValue, style.fontSize));
  }

  svg.removeChild(measureGroup);

  return (text: string, fontSize: number) => {
    const measured = measuredByText.get(text);
    if (measured) return measured;
    return fallbackLabelMeasure(text, fontSize);
  };
}

export function buildDxfPreviewOverlayPrimitives(params: {
  viewer: DxfPreviewOverlayViewer;
  previewRoot: THREE.Object3D;
  featureModel: Dxf2DFeatureModel;
  dimensions: DxfPreviewDimension[];
  style?: Partial<DxfPreviewDimensionStyle>;
  measureLabel?: LabelMeasureFn;
}): DxfPreviewOverlayPrimitives {
  const style = mergeStyle(params.style);
  const size = params.viewer.getRendererSize();
  const width = Math.max(0, size.width);
  const height = Math.max(0, size.height);
  const lines: DxfPreviewOverlayLine[] = [];
  const arrows: DxfPreviewOverlayArrow[] = [];
  const labels: DxfPreviewOverlayLabel[] = [];

  if (width <= 0 || height <= 0 || params.dimensions.length === 0) {
    return { lines, arrows, labels, size: { width, height }, style };
  }

  params.previewRoot.updateWorldMatrix(true, true);
  const silhouette = projectSilhouette({
    viewer: params.viewer,
    previewRoot: params.previewRoot,
    featureModel: params.featureModel,
  });
  if (!silhouette) {
    return { lines, arrows, labels, size: { width, height }, style };
  }
  const silhouetteLabelBox = silhouetteLabelCollisionBox(silhouette);
  const measureLabel = params.measureLabel ?? fallbackLabelMeasure;
  const occupied: Box[] = [];
  const ordered = params.dimensions
    .slice()
    .sort((a, b) => a.priority - b.priority);

  for (const dimension of ordered) {
    const sides = uniqueSideOrder(dimension.sideHints);
    let placed: DimensionCandidate | null = null;
    let fallbackRequired: DimensionCandidate | null = null;

    for (const side of sides) {
      for (const laneOffset of DIMENSION_LANE_OFFSETS) {
        const candidate = buildCandidate({
          dimension,
          side,
          laneOffset,
          viewer: params.viewer,
          previewRoot: params.previewRoot,
          silhouette,
          style,
          measureLabel,
        });
        if (!candidate) continue;

        const outsideSilhouette = !boxesOverlap(candidate.label.box, silhouetteLabelBox);
        if (dimension.required && outsideSilhouette && !fallbackRequired) {
          fallbackRequired = candidate;
        }

        if (!outsideSilhouette) continue;
        if (!dimension.required && !isBoxInsideViewport(candidate.label.box, width, height)) {
          continue;
        }
        if (occupied.some((prev) => boxesOverlap(prev, candidate.label.box))) {
          continue;
        }

        placed = candidate;
        break;
      }
      if (placed) break;
    }

    if (!placed && dimension.required) {
      placed = fallbackRequired;
    }
    if (!placed) continue;

    lines.push(...placed.lines);
    arrows.push(...placed.arrows);
    labels.push(placed.label);
    occupied.push(placed.label.box);
  }

  return { lines, arrows, labels, size: { width, height }, style };
}

export function clearDxfPreviewDimensionSvg(svg: SVGSVGElement | null): void {
  if (!svg) return;
  while (svg.firstChild) {
    svg.removeChild(svg.firstChild);
  }
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tagName: K,
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tagName);
}

function appendArrow(
  svg: SVGSVGElement,
  arrow: DxfPreviewOverlayArrow,
  style: DxfPreviewDimensionStyle,
): void {
  const dir = normalize2D(arrow.dirX, arrow.dirY);
  const perp = { x: -dir.y, y: dir.x };
  const baseX = arrow.tipX - dir.x * style.arrowSize;
  const baseY = arrow.tipY - dir.y * style.arrowSize;
  const wing = style.arrowSize * 0.55;
  const left = { x: baseX + perp.x * wing, y: baseY + perp.y * wing };
  const right = { x: baseX - perp.x * wing, y: baseY - perp.y * wing };

  const path = createSvgElement("path");
  path.setAttribute(
    "d",
    `M ${arrow.tipX} ${arrow.tipY} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`,
  );
  path.setAttribute("fill", style.strokeColor);
  path.setAttribute("opacity", "0.95");
  svg.appendChild(path);
}

export function renderDxfPreviewDimensions(params: {
  svg: SVGSVGElement | null;
  viewer: DxfPreviewOverlayViewer;
  previewRoot: THREE.Object3D;
  featureModel: Dxf2DFeatureModel;
  dimensions: DxfPreviewDimension[];
  style?: Partial<DxfPreviewDimensionStyle>;
}): DxfPreviewOverlayPrimitives {
  const style = mergeStyle(params.style);

  if (!params.svg) {
    return buildDxfPreviewOverlayPrimitives({
      viewer: params.viewer,
      previewRoot: params.previewRoot,
      featureModel: params.featureModel,
      dimensions: params.dimensions,
      style,
    });
  }

  const svg = params.svg;
  clearDxfPreviewDimensionSvg(svg);

  const measureLabel = createTwoPassLabelMeasurer(svg, style, params.dimensions);
  const primitives = buildDxfPreviewOverlayPrimitives({
    viewer: params.viewer,
    previewRoot: params.previewRoot,
    featureModel: params.featureModel,
    dimensions: params.dimensions,
    style,
    measureLabel,
  });

  svg.setAttribute(
    "viewBox",
    `0 0 ${Math.max(1, primitives.size.width)} ${Math.max(1, primitives.size.height)}`,
  );
  svg.setAttribute("width", `${Math.max(0, primitives.size.width)}`);
  svg.setAttribute("height", `${Math.max(0, primitives.size.height)}`);

  for (const line of primitives.lines) {
    const node = createSvgElement("line");
    node.setAttribute("x1", `${line.x1}`);
    node.setAttribute("y1", `${line.y1}`);
    node.setAttribute("x2", `${line.x2}`);
    node.setAttribute("y2", `${line.y2}`);
    node.setAttribute("stroke", primitives.style.strokeColor);
    node.setAttribute("stroke-width", `${primitives.style.strokeWidth}`);
    node.setAttribute("stroke-linecap", "round");
    node.setAttribute("opacity", "0.95");
    svg.appendChild(node);
  }

  for (const arrow of primitives.arrows) {
    appendArrow(svg, arrow, primitives.style);
  }

  for (const label of primitives.labels) {
    const mask = createSvgElement("rect");
    mask.setAttribute("x", `${label.box.x}`);
    mask.setAttribute("y", `${label.box.y}`);
    mask.setAttribute("width", `${label.box.width}`);
    mask.setAttribute("height", `${label.box.height}`);
    mask.setAttribute("rx", "2");
    mask.setAttribute("ry", "2");
    mask.setAttribute("fill", "#ffffff");
    mask.setAttribute("opacity", "0.92");
    svg.appendChild(mask);

    const text = createSvgElement("text");
    text.setAttribute("x", `${label.x}`);
    text.setAttribute("y", `${label.y}`);
    text.setAttribute("fill", primitives.style.textColor);
    text.setAttribute("font-size", `${primitives.style.fontSize}`);
    text.setAttribute("font-family", LABEL_FONT_FAMILY);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.textContent = label.text;
    svg.appendChild(text);
  }

  return primitives;
}
