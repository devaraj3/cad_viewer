import { motion } from "framer-motion";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Head } from "vite-react-ssg";
import { setPendingFile } from "../fileStore";
import AnimatedBackground from "./AnimatedBackground";
import styles from "./Landing.module.css";
import TriangleMark from "./TriangleMark";

const FEATURE_PILLS = [
  "Orbit & Pan",
  "Edge Measurements",
  "Section Planes",
  "Snapshot Export",
];

export default function Landing() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      setPendingFile(file);
      navigate("/viewer");
    }
  };

  return (
    <>
      <Head>
        <title>
          CAD Viewer — View STEP, IGES, STL & OBJ Files in Your Browser
        </title>
        <meta
          name="description"
          content="Free browser-based CAD viewer. Drop a STEP, IGES, STL, OBJ, 3MF, BREP, GLB, or DXF file to orbit, pan, measure edges, apply section planes, and export snapshots — no install, works offline."
        />
        <link rel="canonical" href="https://cadviewer.xyz/" />
      </Head>
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          colorScheme: "light",
          position: "relative",
          overflow: "hidden",
          width: "100vw",
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          outline: isDragging ? "2px solid #3b82f6" : "2px solid transparent",
          outlineOffset: "-4px",
          transition: "outline 0.15s ease",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".step,.stp,.iges,.igs,.stl,.obj,.3mf,.glb,.gltf,.brep,.dxf"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              setPendingFile(file);
              navigate("/viewer");
            }
          }}
        />

        {/* LAYER 0: animated canvas — must be first child */}
        <AnimatedBackground />

        {/* LAYER 1: soft fog — dims the grid/scan behind the hero content, */}
        {/* stays visible in the empty margins around it */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 50% 50%, #f7f8fa 0%, #f7f8fa 45%, rgba(247,248,250,0) 100%)",
            pointerEvents: "none",
            zIndex: 1,
          }}
        />

        {/* LAYER 2: hero content — must be above canvas and fog */}
        <main
          style={{
            position: "relative",
            zIndex: 2,
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <motion.section
            className={styles.hero}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          >
            <TriangleMark size={108} />

            <p className={styles.eyebrow}>
              Browser-based · No install · Offline-capable
            </p>
            <h1 className={styles.headline}>
              View your CAD parts in the browser.
            </h1>
            <p className={styles.subheadline}>
              Drop a STEP, IGES, STL, OBJ, 3MF, BREP, or GLB file and orbit,
              measure, and snapshot in seconds.
            </p>

            <div className={styles.pillRow}>
              {FEATURE_PILLS.map((pill) => (
                <span key={pill} className={styles.pill}>
                  {pill}
                </span>
              ))}
            </div>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{
                background: "#2563eb",
                color: "#ffffff",
                border: "none",
                borderRadius: "8px",
                padding: "0.75rem 2rem",
                fontSize: "1rem",
                fontWeight: 600,
                cursor: "pointer",
                transition: "background 0.15s ease, transform 0.15s ease",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "#1d4ed8";
                (e.currentTarget as HTMLButtonElement).style.transform =
                  "translateY(-1px)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "#2563eb";
                (e.currentTarget as HTMLButtonElement).style.transform =
                  "translateY(0)";
              }}
            >
              Upload CAD File
            </button>

            <a className={styles.ghostLink} href="/viewer">
              or drag a file anywhere on the page
            </a>

            <a className={styles.guideLink} href="/guides/split-step-assembly">
              Need to split an assembly into parts? Read the guide →
            </a>

            <p className={styles.supported}>
              Supported: STEP · IGES · STL · OBJ · 3MF · BREP · GLB · DXF
            </p>
          </motion.section>
        </main>
      </div>
    </>
  );
}
