import React, { useCallback, useState } from 'react'
import type { CadAssemblyNode } from '../loaders/meshLoader'

// ─── Public props ─────────────────────────────────────────────────────────────

export type AssemblyPartsPanelProps = {
  /** Root node of the assembly tree, or null when nothing is loaded */
  root: CadAssemblyNode | null
  /** partId (or name as fallback) of the currently selected part */
  selectedPartId: string | null
  /** Set of partIds (or names) that are currently hidden */
  hiddenPartIds: ReadonlySet<string>
  /** Called when a leaf/sub-assembly part row is clicked */
  onSelectPart: (node: CadAssemblyNode) => void
  /** Called when the eye icon on a row is toggled */
  onToggleVisibility: (node: CadAssemblyNode) => void
  /** Called when "Show all" is clicked */
  onShowAll: () => void
}

// ─── Internal types ───────────────────────────────────────────────────────────

type FlatItem = {
  node: CadAssemblyNode
  depth: number
  isLeaf: boolean
  hasChildren: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Stable key for a node. Uses `cad:<partId>` when partId is available so
 * it aligns with the ModelSession partMap key format from model-session.ts.
 */
export function cadNodeKey(node: CadAssemblyNode): string {
  const partId = node.partId as string | null | undefined
  if (partId && partId.trim().length > 0) return `cad:${partId.trim()}`
  return node.name
}

// internal alias
const nodeKey = cadNodeKey

/** Flatten only the *visible* subtree (respects collapsed state) */
function flattenTree(
  node: CadAssemblyNode,
  depth: number,
  collapsed: ReadonlySet<string>,
  out: FlatItem[],
): void {
  const hasChildren = node.children.length > 0
  const isLeaf = !hasChildren
  out.push({ node, depth, isLeaf, hasChildren })
  if (hasChildren && !collapsed.has(nodeKey(node))) {
    for (const child of node.children) {
      flattenTree(child, depth + 1, collapsed, out)
    }
  }
}

/** Count all leaf-part descendants (for sub-assembly label) */
function countLeaves(node: CadAssemblyNode): number {
  if (node.children.length === 0) return 1
  return node.children.reduce((acc, c) => acc + countLeaves(c), 0)
}

/** Collect all partIds in a subtree (for bulk hide/show) */
function subtreeKeys(node: CadAssemblyNode): string[] {
  const keys: string[] = []
  function collect(n: CadAssemblyNode) {
    keys.push(nodeKey(n))
    n.children.forEach(collect)
  }
  collect(node)
  return keys
}

// ─── Icons (inline SVG, no dependencies) ──────────────────────────────────────

const EyeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
    <path d="M10 3C5 3 1.73 7.11 1.05 10c.68 2.89 3.95 7 8.95 7s8.27-4.11 8.95-7C18.27 7.11 15 3 10 3zm0 12a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z" />
  </svg>
)

const EyeOffIcon = () => (
  <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
    <path d="M2.93 2.93a1 1 0 000 1.41L5.6 7.01C4.1 8.25 3 9.54 2.05 10 2.73 12.89 6 17 11 17c1.5 0 2.9-.37 4.1-.99l2.48 2.48a1 1 0 001.41-1.41l-16-16a1 1 0 00-1.06.85zm8.07 9.9l-1.7-1.7A3 3 0 0010 13a3 3 0 01-2.07-5.13L5.75 5.74A14.5 14.5 0 002.05 10C2.73 12.89 6 17 11 17c.89 0 1.76-.13 2.6-.36l-2.6-2.81zM10 7a3 3 0 012.07 5.13l2.38 2.38C15.9 13.25 17 11.96 17.95 10 17.27 7.11 14 3 10 3 9.1 3 8.24 3.13 7.4 3.36l1.7 1.7A3 3 0 0110 7z" />
  </svg>
)

const ChevronRightIcon = () => (
  <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor">
    <path d="M6.5 4.5l6 5.5-6 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
)

const ChevronDownIcon = () => (
  <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor">
    <path d="M4.5 7.5l5.5 6 5.5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
)

// ─── Component ────────────────────────────────────────────────────────────────

export function AssemblyPartsPanel({
  root,
  selectedPartId,
  hiddenPartIds,
  onSelectPart,
  onToggleVisibility,
  onShowAll,
}: AssemblyPartsPanelProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  if (!root) {
    return (
      <div className="assembly-panel">
        <div className="assembly-panel-header">
          <span className="assembly-panel-title">Parts</span>
        </div>
        <div className="assembly-panel-empty">
          Open a CAD file to see its parts tree.
        </div>
      </div>
    )
  }

  const items: FlatItem[] = []
  flattenTree(root, 0, collapsed, items)

  const anyHidden = hiddenPartIds.size > 0

  return (
    <div className="assembly-panel">
      <div className="assembly-panel-header">
        <span className="assembly-panel-title">Parts</span>
        {anyHidden && (
          <button
            className="assembly-show-all-btn"
            onClick={onShowAll}
            title="Show all parts"
          >
            Show all
          </button>
        )}
      </div>

      <ul className="assembly-part-list">
        {items.map(({ node, depth, isLeaf, hasChildren }) => {
          const key = nodeKey(node)
          const isSelected = key === selectedPartId
          const isHidden = hiddenPartIds.has(key) ||
            (!isLeaf && subtreeKeys(node).every((k) => hiddenPartIds.has(k)))
          const isCollapsed = collapsed.has(key)

          return (
            <li
              key={key + depth}
              className={[
                'assembly-part-row',
                isSelected ? 'assembly-part-row--selected' : '',
                isHidden ? 'assembly-part-row--hidden' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ paddingLeft: `${8 + depth * 16}px` }}
            >
              {/* Expand / collapse toggle for sub-assemblies */}
              <span
                className="assembly-expand-btn"
                onClick={hasChildren ? () => toggleCollapsed(key) : undefined}
                style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
                title={isCollapsed ? 'Expand' : 'Collapse'}
              >
                {isCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
              </span>

              {/* Part name (click to select) */}
              <span
                className="assembly-part-name"
                onClick={() => onSelectPart(node)}
                title={node.name}
              >
                {node.name || '(unnamed)'}
                {hasChildren && (
                  <span className="assembly-part-count">
                    {' '}({countLeaves(node)})
                  </span>
                )}
              </span>

              {/* Eye toggle */}
              <button
                className="assembly-part-eye"
                onClick={() => onToggleVisibility(node)}
                title={isHidden ? 'Show' : 'Hide'}
              >
                {isHidden ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
