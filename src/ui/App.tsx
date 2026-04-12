import React, { useMemo, useState } from "react";
import { CAD_EXTS, CadViewer, MESH_ASSEMBLY_EXTS } from "../components/cad/cad-viewer";
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

  const loadedFileLabel = useMemo(() => {
    if (!file) return "No file loaded";
    const sizeMB = file.size / (1024 * 1024);
    return `${file.name} (${sizeMB.toFixed(2)} MB)`;
  }, [file]);

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const next = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!next) return;

    const ext = next.name.split(".").pop()?.trim().toLowerCase() ?? "";
    if (!isSupportedExt(ext)) {
      setError(
        "Unsupported file type. Use STEP/STP/IGES/IGS/BREP, STL/OBJ/3MF/GLTF/GLB, or DXF.",
      );
      return;
    }

    setError(null);
    setFile(next);
  }

  function clearFile(): void {
    setFile(null);
    setError(null);
  }

  return (
    <div className="cad-app">
      <header className="cad-app__header">
        <div className="cad-app__title-wrap">
          <h1>CAD Viewer</h1>
          <p>Standalone CAD-only viewer migrated from your company CAD module.</p>
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
          backgroundColor="#f1f5f9"
          className="cad-viewer-host"
        />
      </main>
    </div>
  );
}
