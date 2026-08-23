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
  "2D Drawing Export",
];

const CAPABILITIES: { title: string; description: string }[] = [
  {
    title: "View any CAD format, instantly.",
    description:
      "STEP, IGES, STL, OBJ, 3MF, BREP, and GLB open directly in the browser. Orbit, pan, section, and measure edges — no plugin, no viewer app to install separately.",
  },
  {
    title: "Generate a real 2D engineering drawing.",
    description:
      "Click Generate 2D Drawing and get Front, Top, and Right orthographic views in third-angle projection, an isometric reference view, and automatic dimensioning — hole sizes, locations, and overall dimensions placed per standard drafting convention, not just wherever fits visually. Export as a true-to-scale PDF: printed at 100%, the dimensions on the page match the real part.",
  },
  {
    title: "Work with assemblies.",
    description:
      "Explode and disassemble multi-part files, and export any individual part as its own STEP file.",
  },
  {
    title: "Measure what matters.",
    description:
      "Click-to-measure edges, apply section planes, and compare scale against common reference objects.",
  },
];

const FAQS: { question: string; answer: string }[] = [
  {
    question: "Is my file uploaded anywhere?",
    answer:
      "No. Everything is processed client-side in your browser. Files never touch a server.",
  },
  {
    question: "What file formats are supported?",
    answer:
      "STEP, STP, IGES, IGS, BREP, STL, OBJ, 3MF, GLTF, GLB for viewing, and DXF for 2D preview. Generated drawings export as PDF.",
  },
  {
    question: "Can I use the generated drawing for actual manufacturing?",
    answer:
      "For getting a dimensioned drawing for a quote, a personal project, or a student assignment — yes, it's true-to-scale and follows standard drafting convention. For full GD&T with feature control frames and formal revision control, a dedicated CAD package is still the right tool.",
  },
  {
    question: "Is there a catch — will this become paid later?",
    answer: "The viewing and drawing generation tools you see today are free to use.",
  },
  {
    question: "Does this work offline?",
    answer:
      "Yes, once the page and your file are loaded, the viewer runs entirely client-side.",
  },
];

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQS.slice(0, 4).map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: faq.answer,
    },
  })),
};

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
          CAD Viewer — View STEP/IGES Files & Generate 2D Drawings Free
        </title>
        <meta
          name="description"
          content="Free browser-based CAD viewer. View STEP, IGES, STL, OBJ, 3MF, BREP, GLB, and DXF files, then generate a fully dimensioned, true-to-scale 2D engineering drawing — no install, no signup, runs entirely in your browser."
        />
        <link rel="canonical" href="https://cadviewer.xyz/" />
        <body className="landing-page" />
        <script type="application/ld+json">
          {JSON.stringify(FAQ_JSON_LD)}
        </script>
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
              measure, and snapshot in seconds — or generate a dimensioned 2D
              engineering drawing straight from the model.
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

            <a
              className={styles.guideLink}
              href="/guides/step-file-to-2d-drawing"
            >
              Need a 2D drawing from a STEP file? Read the guide →
            </a>

            <p className={styles.supported}>
              Supported: STEP · IGES · STL · OBJ · 3MF · BREP · GLB · DXF
            </p>
          </motion.section>
        </main>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionInner}>
          <h2 className={styles.sectionHeading}>What you can do with it</h2>
          <div className={styles.capabilityGrid}>
            {CAPABILITIES.map((capability) => (
              <div key={capability.title} className={styles.capabilityCard}>
                <h3 className={styles.capabilityTitle}>{capability.title}</h3>
                <p className={styles.capabilityDescription}>
                  {capability.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.sectionAlt}>
        <div className={styles.sectionInner}>
          <h2 className={styles.sectionHeading}>Why it&rsquo;s free</h2>
          <p className={styles.sectionParagraph}>
            Every file you load is processed entirely in your browser —
            nothing is uploaded to a server. That&rsquo;s not a privacy
            feature bolted on top; it&rsquo;s the whole architecture, built
            on OpenCascade compiled to WebAssembly. Because nothing runs
            server-side, there&rsquo;s no hosting cost that scales with
            usage, which is what makes it possible to keep this free rather
            than metered or subscription-gated.
          </p>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionInner}>
          <h2 className={styles.sectionHeading}>
            Frequently asked questions
          </h2>
          <div className={styles.faqGrid}>
            {FAQS.map((faq) => (
              <details className={styles.faqItem} key={faq.question}>
                <summary className={styles.faqQuestion}>
                  {faq.question}
                </summary>
                <p className={styles.faqAnswer}>{faq.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <a className={styles.footerLink} href="/about">
          About
        </a>
        <span className={styles.footerDivider} aria-hidden="true">
          ·
        </span>
        <a
          className={styles.footerLink}
          href="/guides/step-file-to-2d-drawing"
        >
          Guides
        </a>
        <span className={styles.footerDivider} aria-hidden="true">
          ·
        </span>
        <a
          className={styles.footerLink}
          href="mailto:devarajhello@gmail.com"
        >
          Report an issue
        </a>
      </footer>
    </>
  );
}
