import { useCallback, useEffect, useMemo, useState, startTransition } from "react";
import { Link } from "react-router-dom";
import { consumePendingFile } from "../fileStore";
import { CAD_EXTS, CadViewer, MESH_ASSEMBLY_EXTS } from "../components/cad/cad-viewer";
import { EmptyViewportIllustration } from "../pages/illustrations";
import TriangleMark from "../pages/TriangleMark";
import { VIEWER_BG_COLOR } from "../styles/tokenValues";
import "./App.css";

const ACCEPTED_FORMATS = [
  ".step",
  ".stp",
  ".iges",
  ".igs",
  ".brep",
  ".stl",
  ".obj",
  ".3mf",
  ".gltf",
  ".glb",
  ".dxf",
].join(",");

function isSupportedExt(ext: string): boolean {
  return (
    CAD_EXTS.has(ext as "step" | "stp" | "iges" | "igs" | "brep") ||
    MESH_ASSEMBLY_EXTS.has(ext as "obj" | "3mf" | "gltf" | "glb") ||
    ext === "stl" ||
    ext === "dxf"
  );
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerDragging, setViewerDragging] = useState(false);

  const loadedFileLabel = useMemo(() => {
    if (!file) return "No file loaded";
    const sizeMB = file.size / (1024 * 1024);
    return `${file.name} (${sizeMB.toFixed(2)} MB)`;
  }, [file]);

  const handleFile = useCallback((next: File): void => {
    const ext = next.name.split(".").pop()?.trim().toLowerCase() ?? "";
    if (!isSupportedExt(ext)) {
      setError(
        "Unsupported file type. Use STEP/STP/IGES/IGS/BREP, STL/OBJ/3MF/GLTF/GLB, or DXF.",
      );
      return;
    }

    setError(null);
    setFile(next);
  }, []);

  useEffect(() => {
  const pendingFile = consumePendingFile()
  if (!pendingFile) return
  startTransition(() => {
    handleFile(pendingFile)
  })
}, [handleFile]); // eslint-disable-line react-hooks/exhaustive-deps

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const next = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!next) return;
    handleFile(next);
  }

  function clearFile(): void {
    setFile(null);
    setError(null);
  }

  const handleViewerDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setViewerDragging(true);
  };

  const handleViewerDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setViewerDragging(false);
  };

  const handleViewerDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setViewerDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFile(file);
    }
  };

  return (
    <div
      className="cad-app viewer-route"
      onDragOver={handleViewerDragOver}
      onDragLeave={handleViewerDragLeave}
      onDrop={handleViewerDrop}
      style={{
        colorScheme: "light",
        outline: viewerDragging ? "2px solid var(--color-blue-500)" : "none",
        outlineOffset: "-2px",
        transition: "outline 0.12s ease",
      }}
    >
      <header className="cad-app__header">
        <div className="cad-app__title-wrap">
          <Link to="/" className="cad-app__brand-link">
            <TriangleMark size={28} />
            <h1>CAD Viewer</h1>
          </Link>
        </div>
        <div className="cad-app__actions">
          <label className="cad-app__upload-btn">
            <input
              type="file"
              accept={ACCEPTED_FORMATS}
              onChange={onFileChange}
              aria-label="Upload CAD file"
            />
            Upload CAD File
          </label>
          <button type="button" onClick={clearFile} disabled={!file}>
            Clear
          </button>
        </div>
      </header>

      <section className="cad-app__status">
        <span>{loadedFileLabel}</span>
        {error ? <span className="cad-app__error">{error}</span> : null}
      </section>

      <main className="cad-app__viewer">
        <CadViewer
          file={file}
          showControls
          showViewCube
          showHomeButton
          backgroundColor={VIEWER_BG_COLOR}
          className="cad-viewer-host"
        />
        {!file && (
          <div className="cad-app__viewer-empty" aria-hidden="true">
            <EmptyViewportIllustration size={72} />
            <p>Drop a CAD file to get started</p>
          </div>
        )}
      </main>

      {viewerDragging && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(59,130,246,0.06)",
            border: "2px dashed rgba(59,130,246,0.7)",
            borderRadius: "4px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              background: "rgba(8,10,15,0.9)",
              border: "1px solid rgba(59,130,246,0.4)",
              borderRadius: "10px",
              padding: "0.7rem 1.6rem",
              color: "var(--color-blue-500)",
              fontSize: "1rem",
              fontWeight: 500,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.04em",
            }}
          >
            Drop to load file
          </div>
        </div>
      )}
    </div>
  );
}
