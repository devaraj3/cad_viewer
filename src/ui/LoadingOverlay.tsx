// src/ui/LoadingOverlay.tsx
// Custom loading overlay for CAD file processing.
// Shows file name, size, animated stage labels, and a progress bar.

import { useEffect, useState } from "react";

interface LoadingOverlayProps {
  fileName: string;
  fileSize: number;
  progress: number;
  stage: string;
}

function fmtSize(bytes: number): string {
  if (bytes === 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function LoadingOverlay({
  fileName,
  fileSize,
  progress,
  stage,
}: LoadingOverlayProps) {
  const [dots, setDots] = useState(".");

  useEffect(() => {
    const id = setInterval(() => {
      setDots((d) => (d.length >= 3 ? "." : d + "."));
    }, 450);
    return () => clearInterval(id);
  }, []);

  const ext = fileName.split(".").pop()?.toUpperCase() ?? "FILE";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(240,242,245,0.82)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "16px",
          boxShadow: "0 8px 40px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06)",
          padding: "2rem 2.4rem",
          width: "360px",
          display: "flex",
          flexDirection: "column",
          gap: "1.2rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.9rem" }}>
          <div
            style={{
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              borderRadius: "8px",
              padding: "0.4rem 0.65rem",
              fontSize: "0.7rem",
              fontWeight: 700,
              color: "#2563eb",
              letterSpacing: "0.08em",
              fontFamily: "monospace",
              flexShrink: 0,
            }}
          >
            {ext}
          </div>
          <div style={{ overflow: "hidden" }}>
            <div
              style={{
                fontSize: "0.88rem",
                fontWeight: 600,
                color: "#111827",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {fileName}
            </div>
            <div
              style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.1rem" }}
            >
              {fmtSize(fileSize)}
            </div>
          </div>
        </div>

        <div style={{ fontSize: "0.82rem", color: "#4b5563", fontFamily: "monospace" }}>
          {stage}
          {dots}
        </div>

        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "0.4rem",
            }}
          >
            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>Loading</span>
            <span
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                color: "#2563eb",
                fontFamily: "monospace",
              }}
            >
              {Math.round(progress)}%
            </span>
          </div>
          <div
            style={{
              width: "100%",
              height: "6px",
              background: "#e5e7eb",
              borderRadius: "999px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${progress}%`,
                background: "linear-gradient(90deg, #3b82f6, #60a5fa)",
                borderRadius: "999px",
                transition: "width 0.35s ease",
              }}
            />
          </div>
        </div>

        <div
          style={{
            fontSize: "0.72rem",
            color: "#9ca3af",
            textAlign: "center",
          }}
        >
          Large assemblies may take up to a minute to tessellate
        </div>
      </div>
    </div>
  );
}
