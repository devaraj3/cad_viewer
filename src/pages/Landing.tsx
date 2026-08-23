import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Head } from "vite-react-ssg";
import AccordionItem from "../components/AccordionItem";
import Reveal from "../components/Reveal";
import StatsStrip, { type Stat } from "../components/StatsStrip";
import { setPendingFile } from "../fileStore";
import {
  AssemblyIcon,
  ConnectorArrowIcon,
  IconTile,
  MeasureIcon,
  PdfExportIcon,
  UploadIcon,
  ViewFormatsIcon,
} from "./landingIcons";
import styles from "./Landing.module.css";
import TriangleMark from "./TriangleMark";

const FEATURE_PILLS = [
  "Orbit & Pan",
  "Edge Measurements",
  "Section Planes",
  "2D Drawing Export",
];

const STEPS: { title: string; description: string }[] = [
  {
    title: "Drop a file",
    description:
      "STEP, IGES, STL, OBJ, 3MF, BREP, or GLB. Everything runs in your browser — nothing is uploaded.",
  },
  {
    title: "Orbit, measure, section",
    description:
      "Inspect the part from any angle, click edges to measure, or slice it with a section plane.",
  },
  {
    title: "Generate a 2D drawing",
    description:
      "Export dimensioned Front, Top, and Right views as a true-to-scale PDF.",
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

// Real, currently-true numbers only — no placeholder/aspirational figures.
// "Supported" formats count matches the list in the .supported paragraph
// below (STEP, IGES, STL, OBJ, 3MF, BREP, GLB, DXF = 8).
const STATS: Stat[] = [
  { value: 8, label: "File formats supported" },
  { value: 100, suffix: "%", label: "Processed client-side" },
  { value: 0, prefix: "$", label: "Cost to use" },
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
  const heroSpotlightRef = useRef<HTMLDivElement>(null);
  const [pageDragging, setPageDragging] = useState(false);
  const [zoneDragging, setZoneDragging] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled((prev) => {
        const next = window.scrollY > 10;
        return prev === next ? prev : next;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const acceptFile = (file: File) => {
    setPendingFile(file);
    navigate("/viewer");
  };

  const onHeroMouseMove = (e: React.MouseEvent<HTMLElement>) => {
    const el = heroSpotlightRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    el.style.background = `radial-gradient(620px circle at ${x}% ${y}%, rgba(59,130,246,0.13), transparent 62%)`;
  };

  const onPageDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setPageDragging(true);
  };

  const onPageDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setPageDragging(false);
  };

  const onPageDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setPageDragging(false);
    setZoneDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) acceptFile(file);
  };

  const onZoneDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setZoneDragging(true);
  };

  const onZoneDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setZoneDragging(false);
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
        className={[styles.page, pageDragging ? styles.pageDragging : ""]
          .filter(Boolean)
          .join(" ")}
        onDragOver={onPageDragOver}
        onDragLeave={onPageDragLeave}
        onDrop={onPageDrop}
      >
        <nav className={[styles.nav, scrolled ? styles.navScrolled : ""].filter(Boolean).join(" ")}>
          <a href="/" className={styles.navBrand}>
            <TriangleMark size={26} />
            <span className={styles.navBrandText}>CAD Viewer</span>
          </a>
          <a href="/viewer" className={styles.navCta}>
            Launch Viewer
          </a>
        </nav>

        <section className={styles.heroSection} onMouseMove={onHeroMouseMove}>
          <div className={styles.heroGridBg} aria-hidden="true" />
          <div ref={heroSpotlightRef} className={styles.heroSpotlight} aria-hidden="true" />
          <div className={styles.heroScanline} aria-hidden="true" />

          <div className={styles.heroContent}>
            <div className={styles.heroTextCol}>
              <p className={styles.eyebrow}>
                Browser-based · No install · Offline-capable
              </p>
              <h1 className={styles.headline}>
                View your CAD parts in the browser.
              </h1>
              <p className={styles.subheadline}>
                Drop a STEP, IGES, STL, OBJ, 3MF, BREP, or GLB file and orbit,
                measure, and snapshot in seconds — or generate a dimensioned
                2D engineering drawing straight from the model.
              </p>

              <div
                className={[styles.dropzone, zoneDragging ? styles.dropzoneDragging : ""]
                  .filter(Boolean)
                  .join(" ")}
                onDragOver={onZoneDragOver}
                onDragLeave={onZoneDragLeave}
                onDrop={onPageDrop}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
              >
                <IconTile>
                  <UploadIcon />
                </IconTile>
                <span className={styles.dropzoneLabel}>
                  {zoneDragging ? "Drop it here" : "Drop your CAD file here"}
                </span>
                <span className={styles.dropzoneHint}>or click to browse</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".step,.stp,.iges,.igs,.stl,.obj,.3mf,.glb,.gltf,.brep,.dxf"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) acceptFile(file);
                  }}
                />
              </div>

              <div className={styles.pillRow}>
                {FEATURE_PILLS.map((pill) => (
                  <span key={pill} className={styles.pill}>
                    {pill}
                  </span>
                ))}
              </div>

              <div className={styles.linkRow}>
                <a className={styles.guideLink} href="/guides/split-step-assembly">
                  Need to split an assembly into parts? Read the guide →
                </a>
                <a className={styles.guideLink} href="/guides/step-file-to-2d-drawing">
                  Need a 2D drawing from a STEP file? Read the guide →
                </a>
              </div>

              <p className={styles.supported}>
                Supported: STEP · IGES · STL · OBJ · 3MF · BREP · GLB · DXF
              </p>
            </div>

            <div className={styles.heroVisualCol} aria-hidden="true">
              <div className={styles.heroStack}>
                <div className={styles.heroCube}>
                  <div className={styles.heroCubeInner}>
                    <div className={styles.heroCubeFace} style={{ transform: "translateZ(55px)" }} />
                    <div className={styles.heroCubeFace} style={{ transform: "rotateY(180deg) translateZ(55px)" }} />
                    <div className={styles.heroCubeFace} style={{ transform: "rotateY(90deg) translateZ(55px)" }} />
                    <div className={styles.heroCubeFace} style={{ transform: "rotateY(-90deg) translateZ(55px)" }} />
                    <div className={styles.heroCubeFace} style={{ transform: "rotateX(90deg) translateZ(55px)" }} />
                    <div className={styles.heroCubeFace} style={{ transform: "rotateX(-90deg) translateZ(55px)" }} />
                  </div>
                </div>

                <div className={styles.heroCardBack}>
                  <div className={styles.heroImgLabel}>3D MODEL</div>
                  <img src="/hero/3d-model-render.png" alt="" className={styles.heroCardImg} />
                </div>

                <div className={styles.heroConnector}>
                  <ConnectorArrowIcon />
                </div>

                <div className={styles.heroCardFront}>
                  <div className={styles.heroImgLabel}>2D DRAWING</div>
                  <img
                    src="/hero/generated-drawing.png"
                    alt=""
                    width={1280}
                    height={953}
                    className={styles.heroCardImg}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.statsOuter}>
          <Reveal
            as="div"
            className={styles.statsRevealWrap}
            distancePx={28}
            durationMs={600}
          >
            <StatsStrip stats={STATS} />
          </Reveal>
        </section>

        <section className={styles.howSection}>
          <h2 className={styles.sectionHeading}>How it works</h2>
          <div className={styles.stepsRow}>
            {STEPS.map((step, index) => (
              <Reveal
                as="div"
                key={step.title}
                distancePx={28}
                durationMs={600}
                delayMs={index * 80}
              >
                <span className={styles.stepBadge}>0{index + 1}</span>
                <h3 className={styles.stepTitle}>{step.title}</h3>
                <p className={styles.stepDescription}>{step.description}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <section className={styles.capSection}>
          <h2 className={styles.sectionHeading}>What you can do with it</h2>

          <Reveal as="div" className={styles.capFeature} distancePx={28} durationMs={600}>
            <IconTile size="lg">
              <ViewFormatsIcon />
            </IconTile>
            <div>
              <h3 className={styles.capTitle}>View any CAD format, instantly.</h3>
              <p className={styles.capDesc}>
                STEP, IGES, STL, OBJ, 3MF, BREP, and GLB open directly in the
                browser. Orbit, pan, section, and measure edges — no plugin,
                no viewer app to install separately.
              </p>
            </div>
          </Reveal>

          <div className={styles.capGrid}>
            <div className={styles.capCard}>
              <span className={styles.amberTag}>PDF export</span>
              <IconTile>
                <PdfExportIcon />
              </IconTile>
              <h3 className={styles.capTitle}>
                Generate a real 2D engineering drawing.
              </h3>
              <p className={styles.capDesc}>
                Click Generate 2D Drawing and get Front, Top, and Right
                orthographic views in third-angle projection, an isometric
                reference view, and automatic dimensioning — hole sizes,
                locations, and overall dimensions placed per standard
                drafting convention, not just wherever fits visually. Export
                as a true-to-scale PDF: printed at 100%, the dimensions on
                the page match the real part.
              </p>
            </div>
            <div className={styles.capCard}>
              <IconTile>
                <AssemblyIcon />
              </IconTile>
              <h3 className={styles.capTitle}>Work with assemblies.</h3>
              <p className={styles.capDesc}>
                Explode and disassemble multi-part files, and export any
                individual part as its own STEP file.
              </p>
            </div>
            <div className={styles.capCard}>
              <IconTile>
                <MeasureIcon />
              </IconTile>
              <h3 className={styles.capTitle}>Measure what matters.</h3>
              <p className={styles.capDesc}>
                Click-to-measure edges, apply section planes, and compare
                scale against common reference objects.
              </p>
            </div>
          </div>
        </section>

        <section className={styles.whyFreeSection}>
          <Reveal as="div" className={styles.whyFreeInner} distancePx={28} durationMs={600}>
            <div className={styles.whyFreeText}>
              <h2 className={styles.whyFreeHeading}>Why it&rsquo;s free</h2>
              <p className={styles.whyFreeParagraph}>
                Every file you load is processed entirely in your browser —
                nothing is uploaded to a server. That&rsquo;s not a privacy
                feature bolted on top; it&rsquo;s the whole architecture,
                built on OpenCascade compiled to WebAssembly. Because nothing
                runs server-side, there&rsquo;s no hosting cost that scales
                with usage, which is what makes it possible to keep this
                free rather than metered or subscription-gated.
              </p>
            </div>
            <svg
              viewBox="0 0 280 110"
              width="260"
              height="102"
              className={styles.whyFreeDiagram}
              aria-hidden="true"
            >
              <rect x="12" y="15" width="110" height="78" rx="6" fill="none" stroke="#ffffff" strokeWidth="2" />
              <text x="67" y="58" fill="#ffffff" fontFamily="IBM Plex Mono, monospace" fontSize="11" textAnchor="middle">
                Your browser
              </text>
              <path d="M45,30 L55,20 L65,30 M55,20 L55,45" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M75,30 L85,20 L95,30 M85,20 L85,45" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="168" y="15" width="100" height="78" rx="6" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeDasharray="5 5" />
              <text x="218" y="58" fill="rgba(255,255,255,0.5)" fontFamily="IBM Plex Mono, monospace" fontSize="11" textAnchor="middle">
                Server
              </text>
              <line x1="172" y1="19" x2="264" y2="89" stroke="rgba(255,255,255,0.45)" strokeWidth="2" />
            </svg>
          </Reveal>
        </section>

        <section className={styles.faqSection}>
          <Reveal as="div" className={styles.faqInner} distancePx={28} durationMs={600}>
            <h2 className={styles.sectionHeading}>Frequently asked questions</h2>
            <div className={styles.faqList}>
              {FAQS.map((faq) => (
                <AccordionItem
                  key={faq.question}
                  question={faq.question}
                  answer={faq.answer}
                  icon="plus"
                />
              ))}
            </div>
          </Reveal>
        </section>

        <footer className={styles.footer}>
          <a className={styles.footerLink} href="/about">
            About
          </a>
          <span className={styles.footerDivider} aria-hidden="true">
            ·
          </span>
          <a className={styles.footerLink} href="/guides/step-file-to-2d-drawing">
            Guides
          </a>
          <span className={styles.footerDivider} aria-hidden="true">
            ·
          </span>
          <a className={styles.footerLink} href="mailto:devarajhello@gmail.com">
            Report an issue
          </a>
        </footer>
      </div>
    </>
  );
}
