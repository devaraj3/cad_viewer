import type { PickedEntity } from "./exact-cad-topology";
import type { Viewer } from "./viewer";

export type MeasurementInteractionViewer = Pick<
  Viewer,
  | "pickMeasurementEntityAtScreenPosition"
  | "highlightEdgeAtScreenPosition"
  | "measureEdgeAtScreenPosition"
>;

export function runMeasurementHoverInteraction(params: {
  viewer: MeasurementInteractionViewer;
  ndcX: number;
  ndcY: number;
}): PickedEntity | null {
  const pickedEntity = params.viewer.pickMeasurementEntityAtScreenPosition(
    params.ndcX,
    params.ndcY,
  );
  params.viewer.highlightEdgeAtScreenPosition(
    params.ndcX,
    params.ndcY,
    pickedEntity,
  );
  return pickedEntity;
}

export function runMeasurementClickInteraction(params: {
  viewer: MeasurementInteractionViewer;
  ndcX: number;
  ndcY: number;
}): {
  pickedEntity: PickedEntity | null;
  length: number | null;
} {
  const pickedEntity = params.viewer.pickMeasurementEntityAtScreenPosition(
    params.ndcX,
    params.ndcY,
  );
  const length = params.viewer.measureEdgeAtScreenPosition(
    params.ndcX,
    params.ndcY,
    pickedEntity,
  );
  return { pickedEntity, length };
}
