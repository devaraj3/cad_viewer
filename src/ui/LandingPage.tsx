import React from "react";
import { Link } from "react-router-dom";

const CAD_FORMATS = ["STEP", "STP", "IGES", "IGS", "BREP", "STL", "OBJ", "3MF", "GLTF", "GLB", "DXF"];

const FEATURE_CARDS = [
  {
    title: "3D Viewing",
    description: "Inspect CAD and mesh models with smooth navigation, clear shading, and fast camera framing.",
  },
  {
    title: "Measurement",
    description: "Capture accurate edge and geometry dimensions directly in the viewport for quick validation.",
  },
  {
    title: "Cross-Sections",
    description: "Slice models along principal axes to reveal internals and verify wall thickness or clearances.",
  },
  {
    title: "Snapshots",
    description: "Export report-ready normal and outline snapshots to share findings with engineering teams.",
  },
  {
    title: "Assembly Controls",
    description: "Navigate part structures and focus on components without losing overall assembly context.",
  },
  {
    title: "DXF Support",
    description: "Open DXF drawings with dedicated preview support for 2D geometry review workflows.",
  },
];

const AUDIENCE_GROUPS = [
  {
    title: "Mechanical Engineers",
    description: "Review vendor or in-house CAD quickly without opening full authoring suites.",
  },
  {
    title: "Manufacturing Teams",
    description: "Validate geometry details, dimensions, and section cuts before production handoff.",
  },
  {
    title: "QA and Operations",
    description: "Capture consistent snapshots and measurements for documentation and release checks.",
  },
];

export default function LandingPage() {
  return (
    <div className="landing-page">
      <header className="landing-nav">
        <div className="landing-nav__brand">CAD Viewer</div>
        <Link className="landing-nav__link" to="/viewer">
          Open Viewer
        </Link>
      </header>

      <main className="landing-main">
        <section className="hero-section" aria-labelledby="hero-title">
          <p className="hero-section__eyebrow">Engineering Visualization</p>
          <h1 id="hero-title">Inspect CAD assemblies and drawings in seconds.</h1>
          <p className="hero-section__subtitle">
            A focused browser-based CAD viewer for quick model review, measurement, section analysis, and shareable snapshots.
          </p>
          <div className="hero-section__actions">
            <Link className="hero-btn hero-btn--primary" to="/viewer">
              Open Viewer
            </Link>
            <Link className="hero-btn hero-btn--secondary" to="/viewer">
              Try Sample
            </Link>
          </div>
        </section>

        <section className="preview-section" aria-labelledby="preview-title">
          <div className="section-title-wrap">
            <h2 id="preview-title">Product Preview</h2>
            <p>Built for clarity in technical reviews, from quick checks to detailed geometry inspection.</p>
          </div>
          <div className="preview-panel" role="img" aria-label="CAD viewer interface preview">
            <div className="preview-panel__toolbar">
              <span className="preview-dot" />
              <span className="preview-dot" />
              <span className="preview-dot" />
              <div className="preview-panel__title">assembly_rev_a.step</div>
            </div>
            <div className="preview-panel__body">
              <aside className="preview-panel__controls">
                <div className="preview-pill">Measure: On</div>
                <div className="preview-pill">Section X: 42%</div>
                <div className="preview-pill">Units: mm</div>
                <div className="preview-pill">Topology: Exact</div>
              </aside>
              <div className="preview-panel__canvas">
                <div className="preview-grid" />
                <div className="preview-shape preview-shape--primary" />
                <div className="preview-shape preview-shape--accent" />
                <div className="preview-dimension" />
              </div>
            </div>
          </div>
        </section>

        <section className="formats-section" aria-labelledby="formats-title">
          <div className="section-title-wrap">
            <h2 id="formats-title">Supported Formats</h2>
            <p>Open common CAD solids, assemblies, and mesh files from a single interface.</p>
          </div>
          <div className="formats-grid">
            {CAD_FORMATS.map((format) => (
              <span key={format} className="format-chip">
                {format}
              </span>
            ))}
          </div>
        </section>

        <section className="features-section" aria-labelledby="features-title">
          <div className="section-title-wrap">
            <h2 id="features-title">Core Capabilities</h2>
            <p>Purpose-built functionality for modern engineering review cycles.</p>
          </div>
          <div className="feature-grid">
            {FEATURE_CARDS.map((feature) => (
              <article className="feature-card" key={feature.title}>
                <h3>{feature.title}</h3>
                <p>{feature.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="audience-section" aria-labelledby="audience-title">
          <div className="section-title-wrap">
            <h2 id="audience-title">Who It’s For</h2>
            <p>Teams that need confident geometry review without heavy desktop setup.</p>
          </div>
          <div className="audience-grid">
            {AUDIENCE_GROUPS.map((group) => (
              <article className="audience-card" key={group.title}>
                <h3>{group.title}</h3>
                <p>{group.description}</p>
              </article>
            ))}
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <a href="https://github.com/devaraj3/cad_viewer" target="_blank" rel="noreferrer">
          GitHub Repository
        </a>
        <span>Licensed under the Devaraj CAD Viewer Non-Commercial License.</span>
      </footer>
    </div>
  );
}
