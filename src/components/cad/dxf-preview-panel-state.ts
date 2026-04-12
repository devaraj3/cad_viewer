export type DxfPreviewPanelState = {
  expanded: boolean;
  dimensionsEnabled: boolean;
};

export type DxfPreviewPanelVisibility = {
  showExpandButton: boolean;
  showCollapseButton: boolean;
  showDimensionsToggle: boolean;
  showDimensionsOverlay: boolean;
};

export type DxfPreviewPanelTransition = {
  nextState: DxfPreviewPanelState;
  requestRefit: boolean;
  preserveFraming: boolean;
};

export function createDefaultDxfPreviewPanelState(): DxfPreviewPanelState {
  return {
    expanded: false,
    dimensionsEnabled: false,
  };
}

export function getDxfPreviewPanelVisibility(
  state: DxfPreviewPanelState,
): DxfPreviewPanelVisibility {
  const expanded = !!state.expanded;
  const dimensionsEnabled = expanded && !!state.dimensionsEnabled;
  return {
    showExpandButton: !expanded,
    showCollapseButton: expanded,
    showDimensionsToggle: expanded,
    showDimensionsOverlay: dimensionsEnabled,
  };
}

export function expandDxfPreviewPanel(): DxfPreviewPanelTransition {
  return {
    nextState: {
      expanded: true,
      dimensionsEnabled: false,
    },
    requestRefit: false,
    preserveFraming: true,
  };
}

export function collapseDxfPreviewPanel(): DxfPreviewPanelTransition {
  return {
    nextState: {
      expanded: false,
      dimensionsEnabled: false,
    },
    requestRefit: false,
    preserveFraming: true,
  };
}

export function toggleDxfPreviewPanelDimensions(
  state: DxfPreviewPanelState,
): DxfPreviewPanelState {
  if (!state.expanded) {
    return {
      expanded: false,
      dimensionsEnabled: false,
    };
  }
  return {
    expanded: true,
    dimensionsEnabled: !state.dimensionsEnabled,
  };
}
