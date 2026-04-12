import type {
  CircleFeature,
  Dxf2DFeatureModel,
  Vec2,
} from "./dxf-preview-feature-model";

export type DxfDimensionMode = "collapsed" | "expanded";
export type DxfDimensionPlacementSide = "top" | "bottom" | "left" | "right";
export type DxfDimensionPriority = 1 | 2 | 3 | 4 | 5 | 6;

export type DxfLinearDimensionKind =
  | "overall-width"
  | "overall-height"
  | "slot-length"
  | "slot-width";

type DxfDimensionPlacementMeta = {
  priority: DxfDimensionPriority;
  required: boolean;
  sideHints: DxfDimensionPlacementSide[];
};

export type DxfLinearDimension = DxfDimensionPlacementMeta & {
  type: "linear";
  kind: DxfLinearDimensionKind;
  p1Local: Vec2;
  p2Local: Vec2;
  axisLocal: Vec2;
  valueText: string;
};

export type DxfDiameterDimension = DxfDimensionPlacementMeta & {
  type: "diameter";
  kind: "hole-diameter";
  centerLocal: Vec2;
  radiusLocal: number;
  valueText: string;
  count: number;
};

export type DxfPreviewDimension = DxfLinearDimension | DxfDiameterDimension;

type SideDistanceSet = Record<DxfDimensionPlacementSide, number>;

type DimensionCandidate = {
  id: string;
  priority: DxfDimensionPriority;
  tier: "essential" | "expanded";
  kind: "linear" | "diameter" | "slot";
  text: string;
  coveredKeys: string[];
  placementPreference: DxfDimensionPlacementSide;
  renderData: DxfPreviewDimension;
  required: boolean;
};

type IndexedCircleFeature = {
  id: string;
  circle: CircleFeature;
  autoDiameterFamilyCoverageKey: string;
};

const EPS = 1e-9;

export type DxfPreviewDimensionPlanEntry = {
  id: string;
  tier: "essential" | "expanded";
  priority: DxfDimensionPriority;
  coveredKeys: string[];
  renderData: DxfPreviewDimension;
  required: boolean;
};

export type DxfPreviewDimensionPlan = {
  essential: DxfPreviewDimensionPlanEntry[];
  expanded: DxfPreviewDimensionPlanEntry[];
};

function mmLabel(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(2)} mm`;
}

function diameterLabel(value: number): string {
  if (!Number.isFinite(value)) return "⌀-";
  return `⌀${value.toFixed(2)}`;
}

function normalizeVec2(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y);
  if (!Number.isFinite(len) || len <= EPS) return { x: 1, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

function sideDistances(point: Vec2, bounds: Dxf2DFeatureModel["bounds"]): SideDistanceSet {
  return {
    top: Math.max(0, bounds.maxY - point.y),
    bottom: Math.max(0, point.y - bounds.minY),
    left: Math.max(0, point.x - bounds.minX),
    right: Math.max(0, bounds.maxX - point.x),
  };
}

function orderedSidesByDistance(
  point: Vec2,
  bounds: Dxf2DFeatureModel["bounds"],
): DxfDimensionPlacementSide[] {
  const distances = sideDistances(point, bounds);
  return (Object.keys(distances) as DxfDimensionPlacementSide[])
    .sort((lhs, rhs) => distances[lhs] - distances[rhs]);
}

function orderPairByDistance(params: {
  pair: [DxfDimensionPlacementSide, DxfDimensionPlacementSide];
  point: Vec2;
  bounds: Dxf2DFeatureModel["bounds"];
}): DxfDimensionPlacementSide[] {
  const distances = sideDistances(params.point, params.bounds);
  const [a, b] = params.pair;
  return distances[a] <= distances[b] ? [a, b] : [b, a];
}

function sideHintsForAxis(params: {
  axisLocal: Vec2;
  anchor: Vec2;
  bounds: Dxf2DFeatureModel["bounds"];
}): DxfDimensionPlacementSide[] {
  const axis = normalizeVec2(params.axisLocal);
  const horizontal = Math.abs(axis.x) >= Math.abs(axis.y);
  const primaryPair: [DxfDimensionPlacementSide, DxfDimensionPlacementSide] = horizontal
    ? ["top", "bottom"]
    : ["left", "right"];
  const secondaryPair: [DxfDimensionPlacementSide, DxfDimensionPlacementSide] = horizontal
    ? ["left", "right"]
    : ["top", "bottom"];
  return [
    ...orderPairByDistance({
      pair: primaryPair,
      point: params.anchor,
      bounds: params.bounds,
    }),
    ...orderPairByDistance({
      pair: secondaryPair,
      point: params.anchor,
      bounds: params.bounds,
    }),
  ];
}

function toLinearDimension(params: {
  kind: DxfLinearDimensionKind;
  p1Local: Vec2;
  p2Local: Vec2;
  axisLocal: Vec2;
  valueText: string;
  priority: DxfDimensionPriority;
  required?: boolean;
  sideHints: DxfDimensionPlacementSide[];
}): DxfLinearDimension {
  return {
    type: "linear",
    kind: params.kind,
    p1Local: params.p1Local,
    p2Local: params.p2Local,
    axisLocal: normalizeVec2(params.axisLocal),
    valueText: params.valueText,
    priority: params.priority,
    required: params.required ?? false,
    sideHints: params.sideHints,
  };
}

function normalizeFeatureId(raw: string | undefined, fallback: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeCoveredKeys(coveredKeys: string[]): string[] {
  const unique = new Set<string>();
  for (const key of coveredKeys) {
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (trimmed.length === 0) continue;
    unique.add(trimmed);
  }
  return [...unique];
}

function makeDimensionCandidate(params: {
  id: string;
  tier: DimensionCandidate["tier"];
  kind: DimensionCandidate["kind"];
  coveredKeys: string[];
  placementPreference: DxfDimensionPlacementSide;
  renderData: DxfPreviewDimension;
}): DimensionCandidate {
  const coveredKeys = normalizeCoveredKeys(params.coveredKeys);
  return {
    id: params.id,
    priority: params.renderData.priority,
    tier: params.tier,
    kind: params.kind,
    text: params.renderData.valueText,
    coveredKeys,
    placementPreference: params.placementPreference,
    renderData: params.renderData,
    required: params.renderData.required,
  };
}

function groupCirclesByDiameter(params: {
  circles: IndexedCircleFeature[];
  diameterToleranceMm: number;
}): IndexedCircleFeature[][] {
  const ordered = params.circles
    .slice()
    .sort((a, b) => b.circle.diameter - a.circle.diameter);
  if (ordered.length <= 1) return ordered.map((entry) => [entry]);

  const groups: IndexedCircleFeature[][] = [];
  const tol = Math.max(1e-6, params.diameterToleranceMm);
  for (const circle of ordered) {
    let matched: IndexedCircleFeature[] | null = null;
    for (const group of groups) {
      const reference = group[0];
      if (Math.abs(reference.circle.diameter - circle.circle.diameter) <= tol) {
        matched = group;
        break;
      }
    }
    if (matched) {
      matched.push(circle);
    } else {
      groups.push([circle]);
    }
  }
  return groups;
}

function pickRepresentativeCircle(
  circles: IndexedCircleFeature[],
  bounds: Dxf2DFeatureModel["bounds"],
): IndexedCircleFeature {
  if (circles.length <= 1) return circles[0];
  let best = circles[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const circle of circles) {
    const distances = sideDistances(circle.circle.center, bounds);
    const nearest = Math.min(
      distances.top,
      distances.bottom,
      distances.left,
      distances.right,
    );
    if (nearest < bestDist - 1e-9) {
      best = circle;
      bestDist = nearest;
    }
  }
  return best;
}

function buildHoleDimensionCandidates(params: {
  featureModel: Dxf2DFeatureModel;
}): DimensionCandidate[] {
  const { featureModel } = params;
  if (featureModel.circles.length === 0) return [];

  const indexedCircles: IndexedCircleFeature[] = featureModel.circles.map(
    (circle, index) => {
      const circleId = normalizeFeatureId(circle.entityUid, `circle-${index}`);
      return {
        id: circleId,
        circle,
        autoDiameterFamilyCoverageKey: `hole:${circleId}:auto-diameter-family`,
      };
    },
  );
  const bboxDiagonal = Math.hypot(featureModel.bounds.width, featureModel.bounds.height);
  const diameterToleranceMm = Math.max(0.06, bboxDiagonal * 2e-5);
  const grouped = groupCirclesByDiameter({
    circles: indexedCircles,
    diameterToleranceMm,
  });

  const candidates: DimensionCandidate[] = [];
  for (const group of grouped) {
    const representative = pickRepresentativeCircle(group, featureModel.bounds);
    const avgDiameter =
      group.reduce((sum, entry) => sum + entry.circle.diameter, 0) / group.length;
    const sideHints = orderedSidesByDistance(
      representative.circle.center,
      featureModel.bounds,
    );
    const label = group.length > 1
      ? `${group.length}X ${diameterLabel(avgDiameter)}`
      : diameterLabel(avgDiameter);
    const groupedDimension: DxfDiameterDimension = {
      type: "diameter",
      kind: "hole-diameter",
      centerLocal: representative.circle.center,
      radiusLocal: avgDiameter * 0.5,
      valueText: label,
      count: group.length,
      priority: 3,
      required: false,
      sideHints,
    };
    const groupId = group.map((entry) => entry.id).sort().join("|");
    candidates.push(
      makeDimensionCandidate({
        id: `circle-group:${groupId}`,
        tier: "essential",
        kind: "diameter",
        coveredKeys: group.map((entry) => entry.autoDiameterFamilyCoverageKey),
        placementPreference: sideHints[0] ?? "right",
        renderData: groupedDimension,
      }),
    );
  }

  return candidates;
}

function buildSlotDimensionCandidates(params: {
  featureModel: Dxf2DFeatureModel;
}): DimensionCandidate[] {
  const out: DimensionCandidate[] = [];
  for (const [slotIndex, slot] of params.featureModel.slots.entries()) {
    const slotId = normalizeFeatureId(slot.entityUid, `slot-${slotIndex}`);
    const slotKeyBase = `slot:${slotId}`;

    const lengthSideHints = sideHintsForAxis({
      axisLocal: slot.majorAxis,
      anchor: slot.center,
      bounds: params.featureModel.bounds,
    });
    const lengthDimension = toLinearDimension({
      kind: "slot-length",
      p1Local: slot.majorStart,
      p2Local: slot.majorEnd,
      axisLocal: slot.majorAxis,
      valueText: mmLabel(slot.length),
      priority: 4,
      required: false,
      sideHints: lengthSideHints,
    });
    out.push(
      makeDimensionCandidate({
        id: `${slotKeyBase}:length`,
        tier: "expanded",
        kind: "slot",
        coveredKeys: [`${slotKeyBase}:length`],
        placementPreference: lengthSideHints[0] ?? "top",
        renderData: lengthDimension,
      }),
    );

    const widthSideHints = sideHintsForAxis({
      axisLocal: slot.minorAxis,
      anchor: slot.center,
      bounds: params.featureModel.bounds,
    });
    const widthDimension = toLinearDimension({
      kind: "slot-width",
      p1Local: slot.minorStart,
      p2Local: slot.minorEnd,
      axisLocal: slot.minorAxis,
      valueText: mmLabel(slot.width),
      priority: 5,
      required: false,
      sideHints: widthSideHints,
    });
    out.push(
      makeDimensionCandidate({
        id: `${slotKeyBase}:width`,
        tier: "expanded",
        kind: "slot",
        coveredKeys: [`${slotKeyBase}:width`],
        placementPreference: widthSideHints[0] ?? "left",
        renderData: widthDimension,
      }),
    );
  }
  return out;
}

type CoverageComparableDimensionCandidate = Pick<
  DimensionCandidate,
  "id" | "priority" | "coveredKeys" | "renderData" | "required"
>;

function compareDimensionCandidates(
  a: CoverageComparableDimensionCandidate,
  b: CoverageComparableDimensionCandidate,
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.required !== b.required) return a.required ? -1 : 1;
  if (a.coveredKeys.length !== b.coveredKeys.length) {
    return b.coveredKeys.length - a.coveredKeys.length;
  }

  if (a.renderData.type === "diameter" && b.renderData.type === "diameter") {
    if (a.renderData.count !== b.renderData.count) {
      return b.renderData.count - a.renderData.count;
    }
    if (a.renderData.radiusLocal !== b.renderData.radiusLocal) {
      return b.renderData.radiusLocal - a.renderData.radiusLocal;
    }
  }

  return a.id.localeCompare(b.id);
}

function selectDimensionsByCoverage(
  candidates: DxfPreviewDimensionPlanEntry[],
  consumed: Set<string>,
): DxfPreviewDimension[] {
  const selected: DxfPreviewDimension[] = [];
  const ordered = candidates
    .slice()
    .sort(compareDimensionCandidates);

  for (const candidate of ordered) {
    if (candidate.coveredKeys.some((key) => consumed.has(key))) {
      continue;
    }
    selected.push(candidate.renderData);
    for (const key of candidate.coveredKeys) {
      consumed.add(key);
    }
  }

  return selected;
}

export function buildDxfPreviewDimensionPlan(params: {
  featureModel: Dxf2DFeatureModel;
}): DxfPreviewDimensionPlan {
  const { featureModel } = params;
  const essential: DxfPreviewDimensionPlanEntry[] = [];
  const expanded: DxfPreviewDimensionPlanEntry[] = [];

  const pushCandidate = (candidate: DimensionCandidate): void => {
    const entry: DxfPreviewDimensionPlanEntry = {
      id: candidate.id,
      tier: candidate.tier,
      priority: candidate.priority,
      coveredKeys: [...candidate.coveredKeys],
      renderData: candidate.renderData,
      required: candidate.required,
    };
    if (candidate.tier === "essential") {
      essential.push(entry);
      return;
    }
    expanded.push(entry);
  };

  const width = Number.isFinite(featureModel.bounds.width) ? featureModel.bounds.width : 0;
  const overallWidth = toLinearDimension({
    kind: "overall-width",
    p1Local: featureModel.bounds.minXAnchor,
    p2Local: featureModel.bounds.maxXAnchor,
    axisLocal: { x: 1, y: 0 },
    valueText: mmLabel(Math.max(0, width)),
    priority: 1,
    required: true,
    sideHints: ["top", "bottom", "right", "left"],
  });
  pushCandidate(
    makeDimensionCandidate({
      id: "overall:width",
      tier: "essential",
      kind: "linear",
      coveredKeys: ["overall:width"],
      placementPreference: "top",
      renderData: overallWidth,
    }),
  );

  const height = Number.isFinite(featureModel.bounds.height) ? featureModel.bounds.height : 0;
  const overallHeight = toLinearDimension({
    kind: "overall-height",
    p1Local: featureModel.bounds.minYAnchor,
    p2Local: featureModel.bounds.maxYAnchor,
    axisLocal: { x: 0, y: 1 },
    valueText: mmLabel(Math.max(0, height)),
    priority: 2,
    required: true,
    sideHints: ["right", "left", "top", "bottom"],
  });
  pushCandidate(
    makeDimensionCandidate({
      id: "overall:height",
      tier: "essential",
      kind: "linear",
      coveredKeys: ["overall:height"],
      placementPreference: "right",
      renderData: overallHeight,
    }),
  );

  for (const candidate of buildHoleDimensionCandidates({ featureModel })) {
    pushCandidate(candidate);
  }
  for (const candidate of buildSlotDimensionCandidates({ featureModel })) {
    pushCandidate(candidate);
  }

  return { essential, expanded };
}

export function selectDxfPreviewDimensionsFromPlan(params: {
  plan: DxfPreviewDimensionPlan;
  mode?: DxfDimensionMode;
}): DxfPreviewDimension[] {
  const mode: DxfDimensionMode = params.mode ?? "expanded";
  const consumed = new Set<string>();
  const selected = selectDimensionsByCoverage(params.plan.essential, consumed);
  if (mode === "expanded") {
    selected.push(...selectDimensionsByCoverage(params.plan.expanded, consumed));
  }
  return selected;
}

export function buildDxfPreviewDimensions(params: {
  featureModel: Dxf2DFeatureModel;
  mode?: DxfDimensionMode;
}): DxfPreviewDimension[] {
  const plan = buildDxfPreviewDimensionPlan({ featureModel: params.featureModel });
  return selectDxfPreviewDimensionsFromPlan({ plan, mode: params.mode });
}
