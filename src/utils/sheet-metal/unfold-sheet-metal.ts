import { add, cross, dot, length, normalize, scale, sub, tangentBasis, type Vec3 } from "./geometry";
import {
  applyRigid,
  applyRigidDir,
  identityRigid,
  makeFrame,
  rigidFromFrames,
  toRigidTransform,
  type Frame,
  type Rigid,
} from "./rigid-transform";
import { chainFaceLoops, classifyLoops } from "./unfold-topology";
import {
  DEFAULT_SHEET_METAL_OPTIONS,
  type DetectedBend,
  type SheetMetalDetectionResult,
  type SheetMetalFaceInput,
} from "./types";
import { buildWallGroups, estimateSweepAngleDeg, findCylinderPairCandidates, findPlanePairCandidates, thicknessTolerance } from "./detect-sheet-metal";
import {
  DEFAULT_UNFOLD_OPTIONS,
  type FlatBendLine,
  type FlatLoop,
  type FlatMesh,
  type FlatOutlinePart,
  type Point2,
  type UnfoldEdgeInput,
  type UnfoldOptions,
  type UnfoldResult,
  type UnfoldWallResult,
} from "./unfold-types";

function within(value: number, target: number, tol: number): boolean {
  return Math.abs(value - target) <= tol;
}

function faceCentroid(f: SheetMetalFaceInput): Vec3 {
  const v = f.vertices;
  const n = v.length / 3;
  if (n === 0) return f.origin ?? [0, 0, 0];
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < n; i++) {
    x += v[i * 3];
    y += v[i * 3 + 1];
    z += v[i * 3 + 2];
  }
  return [x / n, y / n, z / n];
}

/**
 * Flattens a detected sheet-metal part into a 2D flat pattern.
 *
 * `faces`/`edges` must be the SAME face set given to `detectSheetMetal` (so
 * face ids line up with `detection.bends[].innerFaceId` etc.), plus the
 * richer per-edge 3D curve geometry (`edges` here, not the thinner
 * `SheetMetalEdgeInput`) that flattening needs to measure tangent lines
 * exactly.
 */
export function unfoldSheetMetal(
  faces: SheetMetalFaceInput[],
  edges: UnfoldEdgeInput[],
  detection: SheetMetalDetectionResult,
  options?: Partial<UnfoldOptions>,
): UnfoldResult {
  const opts: UnfoldOptions = { ...DEFAULT_UNFOLD_OPTIONS, ...options };

  if (!detection.isSheetMetal || detection.thicknessMM == null) {
    return {
      ok: false,
      reason: "not_sheet_metal",
      reasonDetail: detection.reasonDetail ?? "Detection did not classify this part as sheet metal.",
    };
  }
  if (detection.embossCount > 0) {
    return {
      ok: false,
      reason: "embosses_present",
      reasonDetail: `${detection.embossCount} emboss/rib/formed feature(s) detected - the unfold engine only flattens plane-and-bend geometry.`,
    };
  }

  const t = detection.thicknessMM;
  const K = opts.kFactor;
  const detOpts = DEFAULT_SHEET_METAL_OPTIONS;
  const tol = thicknessTolerance(t, detOpts);
  const faceById = new Map(faces.map((f) => [f.id, f]));

  for (const bend of detection.bends) {
    if (bend.sharp) continue; // no cylinder faces exist for a zero-radius bend - nothing to validate here
    const innerFace = faceById.get(bend.innerFaceId);
    const outerFace = faceById.get(bend.outerFaceId);
    if (innerFace?.kind !== "cylinder" || outerFace?.kind !== "cylinder") {
      return {
        ok: false,
        reason: "non_developable_surface",
        reasonDetail: `Bend between ${bend.flangeFaceIds.join(" / ")} is not a circular-cylindrical surface (inner=${innerFace?.kind}, outer=${outerFace?.kind}); non-circular bend surfaces are not developable by this engine.`,
      };
    }
  }
  const torusFace = faces.find((f) => f.kind === "torus");
  if (torusFace) {
    return {
      ok: false,
      reason: "non_developable_surface",
      reasonDetail: `Face ${torusFace.id} is a torus - torus surfaces are not developable (cannot be flattened without distortion).`,
    };
  }

  if (detection.bendCount === 0) {
    const ring = tryRolledRing(faces, t, K, tol, opts);
    if (ring) return ring;
  }

  const steppedFeatureFacePairs = detection.steppedFeatures.map((f) => f.flangeFaceIds);
  return unfoldFlangeTree(faces, edges, faceById, detection.bends, steppedFeatureFacePairs, t, K, tol, opts);
}

// --- Bonus case: a single rolled cylindrical band (360deg roll, no flanges) ---

function tryRolledRing(
  faces: SheetMetalFaceInput[],
  t: number,
  K: number,
  tol: number,
  opts: UnfoldOptions,
): UnfoldResult | null {
  const cylinderFaces = faces.filter((f) => f.kind === "cylinder");
  const pairs = findCylinderPairCandidates(cylinderFaces, DEFAULT_SHEET_METAL_OPTIONS).filter((p) =>
    within(p.radiusDiff, t, tol),
  );
  if (pairs.length === 0) return null;

  let best: (typeof pairs)[number] | null = null;
  for (const p of pairs) {
    const outerFace = faces.find((f) => f.id === p.outerId);
    if (!outerFace?.axis || !outerFace.origin) continue;
    const sweep = estimateSweepAngleDeg(outerFace.vertices, outerFace.origin, outerFace.axis, p.outerR);
    if (sweep < 350) continue;
    if (!best || p.weight > best.weight) best = p;
  }
  if (!best) return null;

  const outerFace = faces.find((f) => f.id === best!.outerId)!;
  const innerR = best.innerR;
  const outerR = best.outerR;
  const axis = best.axis;
  const origin = best.origin;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < outerFace.vertices.length; i += 3) {
    const p: Vec3 = [outerFace.vertices[i], outerFace.vertices[i + 1], outerFace.vertices[i + 2]];
    const proj = dot(sub(p, origin), axis);
    if (proj < min) min = proj;
    if (proj > max) max = proj;
  }
  const heightMM = max - min;
  const developedLengthMM = 2 * Math.PI * (innerR + K * t);

  const flatMesh = extrudeRectangle(developedLengthMM, heightMM, t);

  return {
    kind: "rolled_ring",
    ok: true,
    thicknessMM: t,
    kFactor: K,
    skin: opts.skin,
    innerRadius: innerR,
    outerRadius: outerR,
    developedLengthMM,
    heightMM,
    flatMesh,
  };
}

function extrudeRectangle(width: number, height: number, thickness: number): FlatMesh {
  const outer: Point2[] = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
  const { positions, indices } = extrudePolygon(outer, [], thickness);
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

// --- General case: a tree of planar flanges connected by circular bends ---

/**
 * Unions extra face pairs into `wallGroups`' existing roots via a small
 * union-find over the root ids, then remaps every face to its final root -
 * used to fold a stepped feature's own tiny twin-plane "wall" into its
 * parent's wall (see the DetectedSteppedFeature doc comment). A pair whose
 * faces aren't both already in `wallGroups` is skipped (nothing to merge).
 */
function mergeWallGroups(wallGroups: Map<string, string>, mergeFacePairs: Array<[string, string]>): Map<string, string> {
  if (mergeFacePairs.length === 0) return wallGroups;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const root of wallGroups.values()) {
    if (!parent.has(root)) parent.set(root, root);
  }
  for (const [fa, fb] of mergeFacePairs) {
    const ra = wallGroups.get(fa);
    const rb = wallGroups.get(fb);
    if (!ra || !rb) continue;
    union(ra, rb);
  }
  const remapped = new Map<string, string>();
  for (const [face, root] of wallGroups) remapped.set(face, find(root));
  return remapped;
}

type WallInfo = {
  id: string;
  members: Set<string>;
  area: number;
  skinFaceIds: Set<string>;
};

function unfoldFlangeTree(
  faces: SheetMetalFaceInput[],
  edges: UnfoldEdgeInput[],
  faceById: Map<string, SheetMetalFaceInput>,
  bends: DetectedBend[],
  steppedFeatureFacePairs: Array<[string, string]>,
  t: number,
  K: number,
  tol: number,
  opts: UnfoldOptions,
): UnfoldResult {
  const planeFaces = faces.filter((f) => f.kind === "plane");
  if (planeFaces.length === 0) {
    return { ok: false, reason: "no_walls_found", reasonDetail: "No planar flange faces found to build a flat pattern from." };
  }

  const planePairs = findPlanePairCandidates(planeFaces, DEFAULT_SHEET_METAL_OPTIONS).filter((p) =>
    within(p.distance, t, tol),
  );
  // faceId -> rootId (only for paired faces); a stepped feature's own tiny
  // twin-plane "wall" is then folded into its parent's wall root, since an
  // invalid sharp bend must stay attached to the parent rather than become
  // its own unfolded flange (see DetectedSteppedFeature) - its faces are
  // simply extra, non-skin members of the parent wall from here on, so the
  // parent's own flat outline (traced from its own skin face) is unaffected.
  const wallGroups = mergeWallGroups(buildWallGroups(planePairs), steppedFeatureFacePairs);

  // Only faces that matched a twin plane pair at thickness t are genuine
  // flange skins - a real flange always has 2 sides at the sheet thickness.
  // An unpaired plane face is some other incidental planar feature (a
  // chamfer, a counterbore's flat bottom, a small facet of a filleted
  // corner, ...) and must NOT become its own spurious 1-face "wall": every
  // flange this engine needs is already reachable this way, since
  // `bend.flangeFaceIds` is only ever populated from faces already in
  // `wallGroups` (see detect-sheet-metal.ts's flange-group lookup).
  const wallMembers = new Map<string, Set<string>>();
  for (const f of planeFaces) {
    const root = wallGroups.get(f.id);
    if (!root) continue;
    const set = wallMembers.get(root) ?? new Set<string>();
    set.add(f.id);
    wallMembers.set(root, set);
  }

  const facePairAdjacency = new Set<string>();
  for (const e of edges) {
    for (const a of e.adjacentFaceIds) {
      for (const b of e.adjacentFaceIds) {
        if (a !== b) facePairAdjacency.add(`${a}|${b}`);
      }
    }
  }
  const adjacentFaces = (a: string, b: string) => facePairAdjacency.has(`${a}|${b}`);

  // Chosen-skin face(s) per wall: the member(s) topologically adjacent to
  // the bend's chosen-skin cylinder, at every bend touching that wall.
  const skinByWall = new Map<string, Set<string>>();
  const markSkin = (wallId: string, faceId: string) => {
    const s = skinByWall.get(wallId) ?? new Set<string>();
    s.add(faceId);
    skinByWall.set(wallId, s);
  };
  for (const bend of bends) {
    if (bend.sharp) {
      // No cylinder face to test adjacency against - flangeFaceIds already
      // ARE the two real faces sharing the direct fold edge.
      for (const flangeRepId of bend.flangeFaceIds) {
        const wallId = wallGroups.get(flangeRepId) ?? flangeRepId;
        markSkin(wallId, flangeRepId);
      }
      continue;
    }
    const chosenCylId = opts.skin === "outer" ? bend.outerFaceId : bend.innerFaceId;
    for (const flangeRepId of bend.flangeFaceIds) {
      const wallId = wallGroups.get(flangeRepId) ?? flangeRepId;
      const members = wallMembers.get(wallId) ?? new Set([wallId]);
      for (const m of members) {
        if (adjacentFaces(chosenCylId, m)) markSkin(wallId, m);
      }
    }
  }

  const walls = new Map<string, WallInfo>();
  for (const [id, members] of wallMembers) {
    const area = Array.from(members).reduce((s, id2) => s + (faceById.get(id2)?.area ?? 0), 0);
    const skinFaceIds = skinByWall.get(id) ?? new Set([Array.from(members).sort()[0]]);
    walls.set(id, { id, members, area, skinFaceIds });
  }

  let rootWallId = "";
  let rootArea = -1;
  for (const w of walls.values()) {
    if (w.area > rootArea) {
      rootArea = w.area;
      rootWallId = w.id;
    }
  }
  if (!rootWallId) {
    return { ok: false, reason: "no_walls_found", reasonDetail: "Could not determine a base wall." };
  }

  type BendGraphEdge = { bend: DetectedBend; wallA: string; wallB: string };
  const bendGraphEdges: BendGraphEdge[] = bends.map((bend) => ({
    bend,
    wallA: wallGroups.get(bend.flangeFaceIds[0]) ?? bend.flangeFaceIds[0],
    wallB: wallGroups.get(bend.flangeFaceIds[1]) ?? bend.flangeFaceIds[1],
  }));
  const adjacency = new Map<string, BendGraphEdge[]>();
  for (const ge of bendGraphEdges) {
    if (ge.wallA === ge.wallB) continue;
    for (const key of [ge.wallA, ge.wallB]) {
      const list = adjacency.get(key) ?? [];
      list.push(ge);
      adjacency.set(key, list);
    }
  }

  const rigidByWall = new Map<string, Rigid>();
  const visited = new Set<string>();
  const usedBends = new Set<DetectedBend>();
  const bendLines: FlatBendLine[] = [];
  const hemExtensions: HemExtension[] = [];
  const componentOf = new Map<string, string>(); // wallId -> component root id

  // Walks one connected (via bends) component from `startWallId`, laying it
  // out with its own bend-aware transforms - shared by the main tree AND by
  // any additional bend-connected islands the base wall doesn't reach (e.g.
  // a hem-only sub-assembly, or a group of faces the bend classifier
  // connected to each other but not to the rest of the part).
  function walkComponent(startWallId: string) {
    rigidByWall.set(startWallId, rootRigidFor(walls.get(startWallId)!, faceById));
    visited.add(startWallId);
    componentOf.set(startWallId, startWallId);
    const queue: string[] = [startWallId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const ge of adjacency.get(cur) ?? []) {
        if (usedBends.has(ge.bend)) continue;
        const other = ge.wallA === cur ? ge.wallB : ge.wallA;
        if (visited.has(other)) {
          throw {
            ok: false,
            reason: "bend_graph_not_a_tree",
            reasonDetail: `Wall ${other} is reachable via more than one bend path - a single flat blank's bend graph must be a tree.`,
          } satisfies UnfoldResult;
        }
        usedBends.add(ge.bend);
        const computed = computeBend(walls.get(cur)!, walls.get(other)!, ge.bend, rigidByWall.get(cur)!, faceById, edges, t, K, opts);
        if (!computed.ok) throw computed.result;
        rigidByWall.set(other, computed.childRigid);
        bendLines.push(computed.bendLine);
        visited.add(other);
        componentOf.set(other, startWallId);
        queue.push(other);
      }
    }
  }

  try {
    walkComponent(rootWallId);
    // Any wall not reached from the root is either isolated (no bend at
    // all - e.g. the flange classifier didn't connect it, only paired it as
    // a wall) or belongs to its own separate bend-connected island: each
    // becomes its own component, walked the same way, then offset below so
    // it doesn't land on top of the main pattern.
    for (const w of Array.from(walls.keys()).sort()) {
      if (!visited.has(w)) walkComponent(w);
    }
    // Hems / self-loop bends (both ends land on the same wall).
    for (const ge of bendGraphEdges) {
      if (ge.wallA !== ge.wallB) continue;
      const wall = walls.get(ge.wallA)!;
      const computed = computeBend(wall, null, ge.bend, rigidByWall.get(wall.id)!, faceById, edges, t, K, opts);
      if (!computed.ok) throw computed.result;
      bendLines.push(computed.bendLine);
      if (computed.hemExtension) hemExtensions.push(computed.hemExtension);
    }
  } catch (e) {
    if (e && typeof e === "object" && "ok" in e && (e as UnfoldResult).ok === false) return e as UnfoldResult;
    throw e;
  }

  // Lay separate components (the main tree, plus any disconnected islands)
  // side by side instead of all sharing the same local origin, which would
  // otherwise stack them on top of each other.
  const componentIds = Array.from(new Set(componentOf.values())).sort((a, b) => (a === rootWallId ? -1 : b === rootWallId ? 1 : a < b ? -1 : 1));
  const MARGIN = 20;
  // Each already-placed component's final 2D bbox (post-shift), used to
  // detect Y-range overlap - a plain running max-X (1D packing) assumes
  // every component spans roughly the same Y range, which breaks when an
  // isolated bend-island's own natural Y position happens to land inside a
  // DIFFERENT, earlier component's Y range: shifting it only in X (its own
  // 1D slot) can still leave it sitting on top of that earlier component
  // (verified on NewCaster2.0Mirror.step's small isolated tab islands,
  // which landed inside the main pattern's own Y span). Only shift right
  // past components whose Y range the new one actually overlaps.
  const placedBboxes: { minX: number; maxX: number; minY: number; maxY: number }[] = [];
  for (const compId of componentIds) {
    const compWallIds = Array.from(walls.keys()).filter((w) => componentOf.get(w) === compId);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const wId of compWallIds) {
      const w = walls.get(wId)!;
      const rigid = rigidByWall.get(wId)!;
      // Every member, not just the canonical skin face: the through-
      // thickness offset between a wall's 2 (or more) members only moves
      // the mapped Z coordinate, never X/Y, so this is safe - and using
      // only the canonical member under-measured a wall's true flat extent
      // whenever another member (e.g. a corner tab) reaches further.
      for (const memberId of w.members) {
        const face = faceById.get(memberId);
        if (!face) continue;
        for (let i = 0; i < face.vertices.length; i += 3) {
          const p = applyRigid(rigid, [face.vertices[i], face.vertices[i + 1], face.vertices[i + 2]]);
          minX = Math.min(minX, p[0]);
          maxX = Math.max(maxX, p[0]);
          minY = Math.min(minY, p[1]);
          maxY = Math.max(maxY, p[1]);
        }
      }
    }
    if (!Number.isFinite(minX)) continue;
    let shift = 0;
    const overlapsY = (b: { minY: number; maxY: number }) => minY <= b.maxY + MARGIN && b.minY <= maxY + MARGIN;
    const naturalOverlaps = placedBboxes.some((b) => overlapsY(b) && minX <= b.maxX + MARGIN && b.minX <= maxX + MARGIN);
    if (naturalOverlaps) {
      const clearX = Math.max(...placedBboxes.filter(overlapsY).map((b) => b.maxX + MARGIN), minX);
      shift = clearX - minX;
    }
    placedBboxes.push({ minX: minX + shift, maxX: maxX + shift, minY, maxY });
    if (shift !== 0) {
      for (const wId of compWallIds) {
        const r = rigidByWall.get(wId)!;
        rigidByWall.set(wId, { R: r.R, t: add(r.t, [shift, 0, 0]) });
      }
      for (const bl of bendLines) {
        if (compWallIds.includes(bl.parentWallId)) {
          bl.parentTangentLine = [[bl.parentTangentLine[0][0] + shift, bl.parentTangentLine[0][1]], [bl.parentTangentLine[1][0] + shift, bl.parentTangentLine[1][1]]];
        }
        if (compWallIds.includes(bl.childWallId)) {
          bl.childTangentLine = [[bl.childTangentLine[0][0] + shift, bl.childTangentLine[0][1]], [bl.childTangentLine[1][0] + shift, bl.childTangentLine[1][1]]];
        }
      }
      for (const ext of hemExtensions) {
        if (compWallIds.includes(ext.wallId)) {
          ext.rigid = { R: ext.rigid.R, t: add(ext.rigid.t, [shift, 0, 0]) };
        }
      }
    }
  }

  const outline: FlatOutlinePart[] = [];
  const meshPositions: number[] = [];
  const meshIndices: number[] = [];

  for (const w of walls.values()) {
    const rigid = rigidByWall.get(w.id)!;
    const repFaceId = Array.from(w.skinFaceIds).sort(
      (a, b) => (faceById.get(b)?.area ?? 0) - (faceById.get(a)?.area ?? 0),
    )[0];
    const repFace = faceById.get(repFaceId);
    if (!repFace?.origin || !repFace.normal) continue;
    const loops3D = chainFaceLoops(repFaceId, edges);
    const { outer, holes } = classifyLoops(loops3D, repFace.origin, repFace.normal);
    if (outer.length < 3) continue;
    const outer2D = to2D(outer, rigid);
    const holes2D = holes.map((h) => to2D(h, rigid));
    outline.push({ wallId: w.id, sourceFaceIds: Array.from(w.members), outer: outer2D, holes: holes2D });

    const { positions, indices } = extrudePolygon(outer2D, holes2D, t);
    const base = meshPositions.length / 3;
    meshPositions.push(...positions);
    for (const idx of indices) meshIndices.push(idx + base);
  }

  // Hem-lip extensions: a second flat region belonging to an EXISTING wall
  // (its own real material, beyond the hem's curl) that chainFaceLoops from
  // the wall's single canonical member would never reach on its own.
  for (const ext of hemExtensions) {
    const face = faceById.get(ext.faceId);
    if (!face?.origin || !face.normal) continue;
    const loops3D = chainFaceLoops(ext.faceId, edges);
    const { outer, holes } = classifyLoops(loops3D, face.origin, face.normal);
    if (outer.length < 3) continue;
    const outer2D = to2D(outer, ext.rigid);
    const holes2D = holes.map((h) => to2D(h, ext.rigid));
    outline.push({ wallId: ext.wallId, sourceFaceIds: [ext.faceId], outer: outer2D, holes: holes2D });

    const { positions, indices } = extrudePolygon(outer2D, holes2D, t);
    const base = meshPositions.length / 3;
    meshPositions.push(...positions);
    for (const idx of indices) meshIndices.push(idx + base);
  }

  // Bend strips: each bend's own developed BA-wide strip is real flat
  // material too (not a gap between walls) - folded into `outline` itself,
  // not just `flatMesh`, so the flat blank is one continuous region and any
  // outline-based consumer (SVG render, DXF export, the face-coverage
  // oracle) sees it without having to separately reconstruct it from
  // `bendLines`.
  for (const bl of bendLines) {
    // Prefer the strip's real developed boundary (handles corner reliefs);
    // fall back to the plain 4-corner quad for sharp bends (no cylinder
    // face to trace) or if the face boundary couldn't be chained cleanly.
    const quad: Point2[] =
      bl.stripOuter && bl.stripOuter.length >= 3
        ? bl.stripOuter
        : [bl.parentTangentLine[0], bl.parentTangentLine[1], bl.childTangentLine[1], bl.childTangentLine[0]];
    outline.push({ wallId: `${bl.bendId}::strip`, sourceFaceIds: [], outer: quad, holes: [] });
    const { positions, indices } = extrudePolygon(quad, [], t);
    const base = meshPositions.length / 3;
    meshPositions.push(...positions);
    for (const idx of indices) meshIndices.push(idx + base);
  }

  let bboxMin: Point2 = [Infinity, Infinity];
  let bboxMax: Point2 = [-Infinity, -Infinity];
  for (const part of outline) {
    for (const p of part.outer) {
      bboxMin = [Math.min(bboxMin[0], p[0]), Math.min(bboxMin[1], p[1])];
      bboxMax = [Math.max(bboxMax[0], p[0]), Math.max(bboxMax[1], p[1])];
    }
  }

  const wallResults: UnfoldWallResult[] = Array.from(walls.values()).map((w) => ({
    wallId: w.id,
    sourceFaceIds: Array.from(w.members),
    chosenSkinFaceIds: Array.from(w.skinFaceIds),
    areaMM2: w.area,
    transform: toRigidTransform(rigidByWall.get(w.id)!),
    isRoot: w.id === rootWallId,
  }));

  return {
    kind: "flange_tree",
    ok: true,
    thicknessMM: t,
    kFactor: K,
    skin: opts.skin,
    outline,
    bendLines,
    flatMesh: { positions: new Float32Array(meshPositions), indices: new Uint32Array(meshIndices) },
    walls: wallResults,
    bboxMin,
    bboxMax,
  };
}

function rootRigidFor(wall: WallInfo, faceById: Map<string, SheetMetalFaceInput>): Rigid {
  const repFaceId = Array.from(wall.skinFaceIds).sort(
    (a, b) => (faceById.get(b)?.area ?? 0) - (faceById.get(a)?.area ?? 0),
  )[0];
  const repFace = faceById.get(repFaceId);
  if (!repFace?.origin || !repFace.normal) return identityRigid();
  const { u, v } = tangentBasis(repFace.normal);
  const fromFrame = makeFrame(repFace.origin, u, v);
  const toFrame: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  return rigidFromFrames(fromFrame, toFrame);
}

function to2D(loop: Vec3[], rigid: Rigid): FlatLoop {
  return loop.map((p) => {
    const q = applyRigid(rigid, p);
    return [q[0], q[1]] as Point2;
  });
}

function findTangentEdges(cylFaceId: string, memberIds: Set<string>, edges: UnfoldEdgeInput[]): UnfoldEdgeInput[] {
  return edges.filter(
    (e) => e.adjacentFaceIds.includes(cylFaceId) && e.adjacentFaceIds.some((id) => memberIds.has(id)),
  );
}

/** The 2 endpoints of a wall's tangent line against a bend cylinder, merging multiple fragment edges if present. */
function tangentLineEndpoints(tangentEdges: UnfoldEdgeInput[]): [Vec3, Vec3] | null {
  if (tangentEdges.length === 0) return null;
  if (tangentEdges.length === 1) {
    const pl = tangentEdges[0].polyline;
    return [pl[0], pl[pl.length - 1]];
  }
  const refDir = normalize(sub(tangentEdges[0].polyline[tangentEdges[0].polyline.length - 1], tangentEdges[0].polyline[0]));
  let minP = tangentEdges[0].polyline[0];
  let maxP = tangentEdges[0].polyline[0];
  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const e of tangentEdges) {
    for (const p of [e.polyline[0], e.polyline[e.polyline.length - 1]]) {
      const proj = dot(p, refDir);
      if (proj < minProj) {
        minProj = proj;
        minP = p;
      }
      if (proj > maxProj) {
        maxProj = proj;
        maxP = p;
      }
    }
  }
  return [minP, maxP];
}

/** An additional flat region belonging to an existing wall but not reachable from its own canonical (largest-area) member - e.g. a hem-lip's own extra material, unfolded past the hem's curl. */
type HemExtension = { wallId: string; faceId: string; rigid: Rigid };

type ComputeBendResult =
  | { ok: true; childRigid: Rigid; bendLine: FlatBendLine; hemExtension?: HemExtension }
  | { ok: false; result: UnfoldResult };

function computeBend(
  parentWall: WallInfo,
  childWall: WallInfo | null,
  bend: DetectedBend,
  parentRigid: Rigid,
  faceById: Map<string, SheetMetalFaceInput>,
  edges: UnfoldEdgeInput[],
  t: number,
  K: number,
  opts: UnfoldOptions,
): ComputeBendResult {
  const chosenCylId = opts.skin === "outer" ? bend.outerFaceId : bend.innerFaceId;

  // A sharp (zero-radius) bend has no cylinder face to search adjacency
  // against - its flangeFaceIds are already the exact two real faces that
  // share the one direct fold edge (sharpEdgeId), found at detection time.
  const parentSkinId = bend.sharp ? sharpSkinFaceFor(parentWall, bend) : pickAdjacentSkinFace(parentWall, chosenCylId, edges, faceById);
  if (!parentSkinId) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "missing_tangent_edge",
        reasonDetail: bend.sharp
          ? `No flange face of wall ${parentWall.id} matches sharp bend ${bend.sharpEdgeId}.`
          : `No chosen-skin face of wall ${parentWall.id} borders bend cylinder ${chosenCylId}.`,
      },
    };
  }
  const parentEndpoints = bend.sharp
    ? sharpEdgeEndpoints(bend, edges)
    : tangentLineEndpoints(findTangentEdges(chosenCylId, new Set([parentSkinId]), edges));
  if (!parentEndpoints) {
    return {
      ok: false,
      result: { ok: false, reason: "missing_tangent_edge", reasonDetail: `No tangent edge found for wall ${parentWall.id} against bend cylinder ${chosenCylId}.` },
    };
  }

  const axis = normalize(bend.axis);
  const origin = bend.origin;
  const axialCoord = (p: Vec3) => dot(sub(p, origin), axis);
  const [pStartP, pEndP] = orderByAxis(parentEndpoints, axialCoord);
  const xAxisP = normalize(sub(pEndP, pStartP));
  const parentFace = faceById.get(parentSkinId)!;
  const parentNormal = parentFace.normal ?? axis;
  const parentFoldRef = foldDirectionReference(parentSkinId, pStartP, edges, faceById);
  const yAxisP = foldDirection(cross(parentNormal, xAxisP), pStartP, parentFoldRef);

  const targetOriginP = applyRigid(parentRigid, projectOntoCanonicalPlane(pStartP, parentWall, faceById));
  const targetXP = applyRigidDir(parentRigid, xAxisP);
  const targetYP = applyRigidDir(parentRigid, yAxisP);
  const lengthP = Math.abs(dot(sub(pEndP, pStartP), xAxisP));

  const thetaRad = (bend.angleDeg * Math.PI) / 180;
  const Rdev = bend.innerRadius + K * t;
  const BA = thetaRad * Rdev;

  const parentTangentLine: [Point2, Point2] = [
    [targetOriginP[0], targetOriginP[1]],
    [targetOriginP[0] + lengthP * targetXP[0], targetOriginP[1] + lengthP * targetXP[1]],
  ];

  const direction: "up" | "down" = dot(parentNormal, sub(origin, pStartP)) > 0 ? "up" : "down";

  // Real developed boundary of the bend strip, traced from the chosen-skin
  // cylinder's own face boundary (handles corner reliefs / non-rectangular
  // strips correctly) - null for a sharp bend (no cylinder face) or if the
  // face boundary can't be chained cleanly, in which case callers fall back
  // to the 4-corner quad built from the 2 tangent lines.
  const stripOuter = bend.sharp
    ? null
    : developBendStripOuter(chosenCylId, edges, axis, origin, pStartP, xAxisP, yAxisP, targetOriginP, targetXP, targetYP, Rdev);

  if (!childWall) {
    // Hem / dead-end: no further wall-tree geometry, but the hem-lip
    // (the material folded back over itself) can still have its OWN real
    // extra length beyond the curl - its 2 skins get plane-pair-matched
    // into the SAME wall group as the parent flange (they sit exactly t
    // apart from it), so `parentWall.skinFaceIds` can hold a second
    // candidate, besides parentSkinId, that also borders chosenCylId -
    // verified on sh5.STEP, where each hem-lip carries a real 12.35mm of
    // its own flat material that pickAdjacentSkinFace's largest-area
    // tie-break otherwise discards entirely (it always resolves to the
    // parent flange's own, larger-area face).
    const targetOriginC = add(targetOriginP, scale(targetYP, BA));
    const childTangentLine: [Point2, Point2] = [
      [targetOriginC[0], targetOriginC[1]],
      [targetOriginC[0] + lengthP * targetXP[0], targetOriginC[1] + lengthP * targetXP[1]],
    ];

    let hemExtension: HemExtension | undefined;
    const hemLipSkinId = secondAdjacentSkinFace(parentWall, chosenCylId, parentSkinId, edges, faceById);
    if (hemLipSkinId) {
      const hemEndpoints = tangentLineEndpoints(findTangentEdges(chosenCylId, new Set([hemLipSkinId]), edges));
      if (hemEndpoints) {
        const [sStart, sEnd] = orderByAxis(hemEndpoints, axialCoord);
        const xAxisS = normalize(sub(sEnd, sStart));
        const hemFace = faceById.get(hemLipSkinId)!;
        const hemNormal = hemFace.normal ?? axis;
        const hemFoldRef = foldDirectionReference(hemLipSkinId, sStart, edges, faceById);
        const yAxisS = foldDirection(cross(hemNormal, xAxisS), sStart, hemFoldRef);
        const soloWall: WallInfo = { id: hemLipSkinId, members: new Set([hemLipSkinId]), area: hemFace.area, skinFaceIds: new Set([hemLipSkinId]) };
        const fromFrameS = makeFrame(projectOntoCanonicalPlane(sStart, soloWall, faceById), xAxisS, yAxisS);
        const toFrameS = makeFrame(targetOriginC, targetXP, scale(targetYP, -1));
        hemExtension = { wallId: parentWall.id, faceId: hemLipSkinId, rigid: rigidFromFrames(fromFrameS, toFrameS) };
      }
    }

    return {
      ok: true,
      childRigid: parentRigid,
      bendLine: {
        bendId: `${parentWall.id}->hem`,
        parentWallId: parentWall.id,
        childWallId: parentWall.id,
        angleDeg: bend.angleDeg,
        innerRadius: bend.innerRadius,
        outerRadius: bend.outerRadius,
        direction,
        bendAllowanceMM: BA,
        parentTangentLine,
        childTangentLine,
        parentSkinFaceId: parentSkinId,
        childSkinFaceId: parentSkinId,
        stripOuter: stripOuter ?? undefined,
      },
      hemExtension,
    };
  }

  const childSkinId = bend.sharp ? sharpSkinFaceFor(childWall, bend) : pickAdjacentSkinFace(childWall, chosenCylId, edges, faceById);
  if (!childSkinId) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "missing_tangent_edge",
        reasonDetail: bend.sharp
          ? `No flange face of wall ${childWall.id} matches sharp bend ${bend.sharpEdgeId}.`
          : `No chosen-skin face of wall ${childWall.id} borders bend cylinder ${chosenCylId}.`,
      },
    };
  }
  const childEndpoints = bend.sharp
    ? sharpEdgeEndpoints(bend, edges)
    : tangentLineEndpoints(findTangentEdges(chosenCylId, new Set([childSkinId]), edges));
  if (!childEndpoints) {
    return {
      ok: false,
      result: { ok: false, reason: "missing_tangent_edge", reasonDetail: `No tangent edge found for wall ${childWall.id} against bend cylinder ${chosenCylId}.` },
    };
  }
  const [pStartC, pEndC] = orderByAxis(childEndpoints, axialCoord);
  const xAxisC = normalize(sub(pEndC, pStartC));
  const childFace = faceById.get(childSkinId)!;
  const childNormal = childFace.normal ?? axis;
  const childFoldRef = foldDirectionReference(childSkinId, pStartC, edges, faceById);
  const yAxisC = foldDirection(cross(childNormal, xAxisC), pStartC, childFoldRef);
  const fromFrameC = makeFrame(projectOntoCanonicalPlane(pStartC, childWall, faceById), xAxisC, yAxisC);

  // The child's tangent line sits BA further along target_yP (away from the
  // parent). But the child's OWN "away from interior, toward bend" axis
  // (yAxisC) must map to the OPPOSITE flat direction (-target_yP): the
  // child's interior needs to continue extending AWAY from the parent (a
  // straight [flange][bend][flange] strip), not fold back over it. Mapping
  // yAxisC -> +target_yP (the naive, unflipped choice) sends the child's
  // interior back toward +target_yP - i.e. back over the parent's own span,
  // producing an overlapping flat pattern instead of a laid-out strip.
  // targetOriginC must land at pStartC's OWN flat position - which is NOT
  // just "BA along targetYP from targetOriginP" whenever the strip is
  // tapered (a corner relief): pStartC generally sits at a DIFFERENT axial
  // coordinate than pStartP (see developBendStripOuter's same reasoning),
  // so the child frame's origin needs that same axial offset folded in,
  // or the whole child wall (and everything built on it) ends up shifted
  // along the bend by the taper amount. Zero for an untapered/rectangular
  // flange (pStartC and pStartP share the same axial coordinate there), so
  // this is a no-op in the common case.
  const childAxialOffsetFromParent = dot(sub(pStartC, pStartP), xAxisP);
  const targetOriginC = add(targetOriginP, add(scale(targetXP, childAxialOffsetFromParent), scale(targetYP, BA)));
  const toFrameC = makeFrame(targetOriginC, targetXP, scale(targetYP, -1));
  const childRigid = rigidFromFrames(fromFrameC, toFrameC);

  const lengthC = Math.abs(dot(sub(pEndC, pStartC), xAxisC));
  const childTangentLine: [Point2, Point2] = [
    [targetOriginC[0], targetOriginC[1]],
    [targetOriginC[0] + lengthC * targetXP[0], targetOriginC[1] + lengthC * targetXP[1]],
  ];

  return {
    ok: true,
    childRigid,
    bendLine: {
      bendId: `${parentWall.id}->${childWall.id}`,
      parentWallId: parentWall.id,
      childWallId: childWall.id,
      angleDeg: bend.angleDeg,
      innerRadius: bend.innerRadius,
      outerRadius: bend.outerRadius,
      direction,
      bendAllowanceMM: BA,
      parentTangentLine,
      childTangentLine,
      parentSkinFaceId: parentSkinId,
      childSkinFaceId: childSkinId,
      stripOuter: stripOuter ?? undefined,
    },
  };
}

/**
 * Traces the chosen-skin cylinder face's own 3D boundary loop and develops
 * every vertex into flat space by its true (axial offset, swept angle)
 * position - not just the 2 tangent lines' own endpoints. A plain
 * rectangular flange's cylinder face has 2 straight tangent edges (the ones
 * `parentTangentLine`/`childTangentLine` already measure) plus 2 "side"
 * edges at constant axial position, so this reduces to the same rectangle
 * the old fixed 4-corner quad assumed. But a corner-relief cut carves the
 * flange's edge into the bend zone too, so the cylinder face's real side
 * edges are NOT constant-axial-position arcs there - they trace a curve
 * whose axial position shifts continuously with angle (a straight cut in
 * the flat pattern becomes a helix-like curve once rolled onto the
 * cylinder). Walking the face's ACTUAL boundary and mapping each point by
 * its own angle (not assuming the parent/child tangent edges have the same
 * length or the same axial extent) reproduces that relief correctly instead
 * of silently squaring it off into a rectangle.
 *
 * `Rdev` = bend.innerRadius + K*t, the same neutral-fiber radius `BA` uses -
 * so a boundary point swept phi radians from the parent tangent line lands
 * at flat-space offset phi*Rdev, exactly like the parent (phi=0) and child
 * (phi=thetaRad) tangent lines already do.
 */
function developBendStripOuter(
  cylFaceId: string,
  edges: UnfoldEdgeInput[],
  axis: Vec3,
  origin: Vec3,
  pStartP: Vec3,
  xAxisP: Vec3,
  yAxisP: Vec3,
  targetOriginP: Vec3,
  targetXP: Vec3,
  targetYP: Vec3,
  Rdev: number,
): Point2[] | null {
  const loops = chainFaceLoops(cylFaceId, edges);
  if (loops.length !== 1) return null; // a hole in the bend face, or a chaining failure - fall back to the quad
  const loop = loops[0];
  if (loop.length < 3) return null;

  const radial = (p: Vec3): Vec3 => {
    const d = dot(sub(p, origin), axis);
    return sub(sub(p, origin), scale(axis, d));
  };
  const r0vec = radial(pStartP);
  const r0len = length(r0vec);
  if (r0len < 1e-6) return null; // pStartP degenerate (on the axis) - shouldn't happen for a real tangent point
  const r0 = scale(r0vec, 1 / r0len);
  // Calibrate which rotation sense (about +axis vs -axis) matches the
  // PHYSICAL fold direction: d(radial)/dtheta at theta=0 is axis x r0 for
  // the convention atan2(dot(cross(r0,rp),axis), dot(r0,rp)) below; compare
  // against yAxisP (already validated elsewhere as "into the fold, in 3D,
  // at theta=0") to pick the sign, rather than needing any point on the
  // child side.
  const tangentAtZero = cross(axis, r0);
  const phiSign = dot(tangentAtZero, yAxisP) >= 0 ? 1 : -1;

  let startIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const d = length(sub(loop[i], pStartP));
    if (d < bestD) {
      bestD = d;
      startIdx = i;
    }
  }
  const rotated = [...loop.slice(startIdx), ...loop.slice(0, startIdx)];

  const rawAngle = (p: Vec3): number => {
    const rp = radial(p);
    const rpLen = length(rp);
    if (rpLen < 1e-9) return 0;
    const rpn = scale(rp, 1 / rpLen);
    const cosA = dot(r0, rpn);
    const sinA = dot(cross(r0, rpn), axis);
    return Math.atan2(sinA, cosA);
  };

  // Sequential unwrap (anchored at pStartP, so unwrapped[0] ~= 0 exactly) -
  // robust across the full angular range (including hems near +-180deg),
  // unlike a raw per-point atan2 which would wrap at +-pi.
  const unwrapped: number[] = new Array(rotated.length);
  unwrapped[0] = rawAngle(rotated[0]);
  for (let i = 1; i < rotated.length; i++) {
    let delta = rawAngle(rotated[i]) - rawAngle(rotated[i - 1]);
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    unwrapped[i] = unwrapped[i - 1] + delta;
  }

  return rotated.map((p, i) => {
    const localX = dot(sub(p, pStartP), xAxisP);
    const localY = phiSign * unwrapped[i] * Rdev;
    const flat = add(targetOriginP, add(scale(targetXP, localX), scale(targetYP, localY)));
    return [flat[0], flat[1]] as Point2;
  });
}

/** For a sharp (zero-radius) bend, flangeFaceIds already ARE the exact two real faces sharing the one direct fold edge - just pick whichever belongs to this wall. */
function sharpSkinFaceFor(wall: WallInfo, bend: DetectedBend): string | null {
  return bend.flangeFaceIds.find((id) => wall.members.has(id)) ?? null;
}

function sharpEdgeEndpoints(bend: DetectedBend, edges: UnfoldEdgeInput[]): [Vec3, Vec3] | null {
  const edge = edges.find((e) => e.id === bend.sharpEdgeId);
  if (!edge) return null;
  return [edge.polyline[0], edge.polyline[edge.polyline.length - 1]];
}

function pickAdjacentSkinFace(
  wall: WallInfo,
  cylFaceId: string,
  edges: UnfoldEdgeInput[],
  faceById: Map<string, SheetMetalFaceInput>,
): string | null {
  const candidates = Array.from(wall.skinFaceIds).filter(
    (id) => findTangentEdges(cylFaceId, new Set([id]), edges).length > 0,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (faceById.get(b)?.area ?? 0) - (faceById.get(a)?.area ?? 0));
  return candidates[0];
}

/**
 * A second, smaller-area wall member (besides `excludeId`, normally the
 * primary `pickAdjacentSkinFace` pick) that ALSO borders the same bend
 * cylinder - a hem-lip's own near face, plane-pair-matched into the same
 * wall group as its parent flange. Only ever meaningful for a self-loop
 * (hem) bend, where both ends of the cylinder's sweep land on the same
 * wall group; a normal 2-wall bend's cylinder only ever borders one member
 * per side, so this returns null there.
 */
function secondAdjacentSkinFace(
  wall: WallInfo,
  cylFaceId: string,
  excludeId: string,
  edges: UnfoldEdgeInput[],
  faceById: Map<string, SheetMetalFaceInput>,
): string | null {
  const candidates = Array.from(wall.skinFaceIds).filter(
    (id) => id !== excludeId && findTangentEdges(cylFaceId, new Set([id]), edges).length > 0,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (faceById.get(b)?.area ?? 0) - (faceById.get(a)?.area ?? 0));
  return candidates[0];
}

function orderByAxis(pts: [Vec3, Vec3], axialCoord: (p: Vec3) => number): [Vec3, Vec3] {
  return axialCoord(pts[0]) <= axialCoord(pts[1]) ? pts : [pts[1], pts[0]];
}

function awayFromInterior(candidate: Vec3, edgePoint: Vec3, interiorPoint: Vec3): Vec3 {
  const u = normalize(candidate);
  const towardInterior = dot(u, sub(interiorPoint, edgePoint)) > 0;
  return towardInterior ? scale(u, -1) : u;
}

/**
 * The "fold away from the wall's own bulk material" rule is correct for a
 * normal edge flange, whose tangent line sits on the wall's OUTER boundary -
 * the flat position genuinely extends past the wall's own edge, away from
 * its centroid. It is backwards for a LANCED TAB (cut on the other sides
 * from the middle of a wall and bent up along the one uncut/tangent side):
 * there, the tangent line sits on the boundary of an INTERIOR HOLE, and the
 * tab's flat position exactly fills the hole it was cut from - i.e. the
 * correct fold direction is INTO that hole's own centroid, not away from
 * the wall's unrelated overall centroid (which, depending on where the hole
 * happens to sit within the wall, bears no consistent relationship to which
 * way the hole itself lies). Detected by checking which of the skin face's
 * own boundary loops (chained fresh here, not reused from any per-part
 * cache) the tangent point actually lies on.
 */
function foldDirectionReference(
  skinFaceId: string,
  tangentPoint: Vec3,
  edges: UnfoldEdgeInput[],
  faceById: Map<string, SheetMetalFaceInput>,
): { referencePoint: Vec3; away: boolean } {
  const face = faceById.get(skinFaceId);
  const fallback = { referencePoint: face ? faceCentroid(face) : tangentPoint, away: true };
  if (!face?.origin || !face.normal) return fallback;
  const loops = chainFaceLoops(skinFaceId, edges);
  if (loops.length <= 1) return fallback; // no holes at all - nothing to distinguish
  const { holes } = classifyLoops(loops, face.origin, face.normal);
  const onLoop = (loop: Vec3[]) => loop.some((p) => length(sub(p, tangentPoint)) < 1e-3);
  const hole = holes.find(onLoop);
  if (!hole) return fallback;
  let cx = 0, cy = 0, cz = 0;
  for (const p of hole) { cx += p[0]; cy += p[1]; cz += p[2]; }
  const centroid: Vec3 = [cx / hole.length, cy / hole.length, cz / hole.length];
  return { referencePoint: centroid, away: false };
}

function foldDirection(candidate: Vec3, edgePoint: Vec3, ref: { referencePoint: Vec3; away: boolean }): Vec3 {
  const awayDir = awayFromInterior(candidate, edgePoint, ref.referencePoint);
  return ref.away ? awayDir : scale(awayDir, -1);
}

/**
 * A wall's two flange-pair skin faces are parallel planes t apart, so
 * different bends touching the SAME wall can each be tangent to a
 * DIFFERENT one of the two (verified on sh4.STEP: the lanced tab's bend is
 * tangent to the wall's inner face, while the wall's other, ordinary bend
 * is tangent to its outer face - physically legitimate, a tab can fold in
 * the opposite rotational sense from a perimeter flange on the same wall).
 * But the wall's own flat placement (`parentRigid`/`rootRigidFor`) is
 * always built from ONE canonical member (its largest-area skin face).
 * Feeding a tangent point measured on the OTHER member straight into that
 * transform leaves a leftover offset of exactly the plane-to-plane gap
 * (thickness) baked into the flat position. Projecting onto the canonical
 * member's own plane first removes that offset - safe because the two
 * planes are parallel, so the projection changes nothing else (direction
 * vectors, in-plane spacing) and is a no-op when the tangent point already
 * came from the canonical member itself.
 */
function projectOntoCanonicalPlane(p: Vec3, wall: WallInfo, faceById: Map<string, SheetMetalFaceInput>): Vec3 {
  const repId = Array.from(wall.skinFaceIds).sort(
    (a, b) => (faceById.get(b)?.area ?? 0) - (faceById.get(a)?.area ?? 0),
  )[0];
  const repFace = faceById.get(repId);
  if (!repFace?.origin || !repFace.normal) return p;
  const n = normalize(repFace.normal);
  const d = dot(sub(p, repFace.origin), n);
  return sub(p, scale(n, d));
}

// --- Meshing (triangulate-with-holes + extrude by thickness, for display) ---
//
// A small self-contained ear-clipping triangulator (holes handled by
// bridging each into the outer boundary via its nearest outer vertex, the
// classic pre-earcut technique) - avoids depending on three's Earcut, which
// this three version's published build doesn't actually export (only its
// unbundled src/ does).

function signedAreaOfIndices(points: Point2[], idx: number[]): number {
  let a = 0;
  for (let i = 0; i < idx.length; i++) {
    const p = points[idx[i]];
    const q = points[idx[(i + 1) % idx.length]];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function sign(v: number): number {
  return v > 1e-12 ? 1 : v < -1e-12 ? -1 : 0;
}

function pointInTriangle(p: Point2, a: Point2, b: Point2, c: Point2): boolean {
  const d1 = sign((b[0] - p[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - p[1]));
  const d2 = sign((c[0] - p[0]) * (b[1] - p[1]) - (b[0] - p[0]) * (c[1] - p[1]));
  const d3 = sign((a[0] - p[0]) * (c[1] - p[1]) - (c[0] - p[0]) * (a[1] - p[1]));
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clips a simple CCW polygon given as indices into `points` (a shared
 * point pool - possibly containing points not on this loop, and possibly
 * revisiting the same original point twice via a hole-bridge). Returns
 * triangles as index triples referencing `points` directly, so callers never
 * need to remap indices after bridging holes in.
 */
function earClipIndices(points: Point2[], loopIndices: number[]): number[] {
  const indices = loopIndices.slice();
  const triangles: number[] = [];
  let guard = 0;
  while (indices.length > 3 && guard++ < loopIndices.length * loopIndices.length + 16) {
    let clipped = false;
    for (let i = 0; i < indices.length; i++) {
      const n = indices.length;
      const iPrev = indices[(i - 1 + n) % n];
      const iCur = indices[i];
      const iNext = indices[(i + 1) % n];
      const a = points[iPrev], b = points[iCur], c = points[iNext];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross <= 1e-12) continue; // reflex or degenerate at this vertex
      let containsOther = false;
      for (const idx of indices) {
        if (idx === iPrev || idx === iCur || idx === iNext) continue;
        if (pointInTriangle(points[idx], a, b, c)) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) continue;
      triangles.push(iPrev, iCur, iNext);
      indices.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate/self-intersecting input - stop rather than loop forever
  }
  if (indices.length === 3) triangles.push(indices[0], indices[1], indices[2]);
  return triangles;
}

/** Splices a hole's index loop into the outer index loop via a bridge to its nearest outer vertex, producing one simple index loop (repeated indices at the bridge, which is fine - they resolve to the same point). */
function bridgeHoleIndices(points: Point2[], outerLoop: number[], holeLoop: number[]): number[] {
  let hPos = 0;
  for (let i = 1; i < holeLoop.length; i++) {
    if (points[holeLoop[i]][0] > points[holeLoop[hPos]][0]) hPos = i;
  }
  const hIdx = holeLoop[hPos];
  const h = points[hIdx];
  let mPos = 0;
  let bestDist = Infinity;
  for (let i = 0; i < outerLoop.length; i++) {
    const p = points[outerLoop[i]];
    const dx = p[0] - h[0];
    const dy = p[1] - h[1];
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      mPos = i;
    }
  }
  const rotatedHole = [...holeLoop.slice(hPos), ...holeLoop.slice(0, hPos)];
  const merged: number[] = [];
  for (let i = 0; i <= mPos; i++) merged.push(outerLoop[i]);
  merged.push(...rotatedHole, rotatedHole[0]);
  for (let i = mPos; i < outerLoop.length; i++) merged.push(outerLoop[i]);
  return merged;
}

/** Triangulates outer+holes (each a simple polygon) into triangles indexing the concatenated [outer, ...holes] point pool - the same layout `extrudePolygon` uses for its position buffer. */
function triangulatePolygonWithHoles(outer: Point2[], holes: Point2[][]): { points: Point2[]; triangles: number[] } {
  const points: Point2[] = [...outer];
  const outerIdx = outer.map((_, i) => i);
  let mergedLoop = signedAreaOfIndices(points, outerIdx) < 0 ? outerIdx.slice().reverse() : outerIdx;

  for (const hole of holes) {
    const start = points.length;
    points.push(...hole);
    let holeIdx = hole.map((_, i) => start + i);
    if (signedAreaOfIndices(points, holeIdx) > 0) holeIdx = holeIdx.slice().reverse();
    mergedLoop = bridgeHoleIndices(points, mergedLoop, holeIdx);
  }

  const triangles = earClipIndices(points, mergedLoop);
  return { points, triangles };
}

function extrudePolygon(outer: Point2[], holes: Point2[][], thickness: number): { positions: number[]; indices: number[] } {
  const { points, triangles } = triangulatePolygonWithHoles(outer, holes);
  const n = points.length;
  const positions: number[] = [];
  for (const p of points) positions.push(p[0], p[1], 0);
  for (const p of points) positions.push(p[0], p[1], -thickness);

  const indices: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    indices.push(triangles[i], triangles[i + 1], triangles[i + 2]);
  }
  for (let i = 0; i < triangles.length; i += 3) {
    indices.push(n + triangles[i + 2], n + triangles[i + 1], n + triangles[i]);
  }

  let cursor = 0;
  const addSideWalls = (len: number) => {
    for (let i = 0; i < len; i++) {
      const a = cursor + i;
      const b = cursor + ((i + 1) % len);
      indices.push(a, b, b + n, a, b + n, a + n);
    }
    cursor += len;
  };
  addSideWalls(outer.length);
  for (const h of holes) addSideWalls(h.length);

  return { positions, indices };
}
