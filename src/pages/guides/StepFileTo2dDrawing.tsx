import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Head } from "vite-react-ssg";
import styles from "./StepFileTo2dDrawing.module.css";

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.externalLink}
    >
      {children}
    </a>
  );
}

type Step = {
  title: string;
  description: ReactNode;
};

const STEPS: Step[] = [
  {
    title: "Load your file",
    description: (
      <>
        Go to{" "}
        <Link to="/" className={styles.externalLink}>
          cadviewer.xyz
        </Link>{" "}
        and drop in your file. STEP,
        IGES, STL, OBJ, 3MF, BREP, or GLB all work. Nothing to install, no
        account to create, and the file never leaves your browser — it's
        processed client-side. You'll get an interactive 3D view
        immediately — rotate, section, and measure it like you would in any
        CAD viewer.
      </>
    ),
  },
  {
    title: "Generate the drawing",
    description: (
      <>
        Click <strong>Generate 2D Drawing</strong>. This captures true
        orthographic Front, Top, and Right views in third-angle projection,
        adds an isometric reference view, and dimensions the part
        automatically — hole sizes, locations, overall dimensions —
        following standard drafting conventions, not just whatever fits
        visually.
      </>
    ),
  },
  {
    title: "Adjust anything that needs it",
    description: (
      <>
        <p className={styles.stepDescription} style={{ margin: 0 }}>
          The drawing opens in an editor where you can:
        </p>
        <ul className={styles.list} style={{ marginTop: "0.5rem" }}>
          <li>Choose a specific scale, or let it pick the best fit automatically</li>
          <li>Reposition individual dimensions or whole views if anything's crowded</li>
          <li>Add numbered notes (tolerances, finish, material)</li>
          <li>Fill in a proper title block — part name, material, drawn-by, your own logo</li>
        </ul>
      </>
    ),
  },
  {
    title: "Export",
    description: (
      <>
        Download it as a true-to-scale PDF. Printed at 100%, the dimensions
        on the page match the real part — it's not just a picture of a
        drawing, it's one you can actually use.
      </>
    ),
  },
];

const FAQS: { question: string; answer: ReactNode; answerText: string }[] = [
  {
    question: "Does this replace SolidWorks or Fusion for real production drawings?",
    answer: (
      <>
        For getting a dimensioned drawing out of a model quickly — for a
        machine shop quote, a personal project, or a student assignment —
        yes. For full{" "}
        <ExternalLink href="https://en.wikipedia.org/wiki/Geometric_dimensioning_and_tolerancing">
          GD&T
        </ExternalLink>{" "}
        with feature control frames and formal revision control, a dedicated
        CAD package is still the right tool.
      </>
    ),
    answerText:
      "For getting a dimensioned drawing out of a model quickly — for a machine shop quote, a personal project, or a student assignment — yes. For full GD&T with feature control frames and formal revision control, a dedicated CAD package is still the right tool.",
  },
  {
    question: "Is my file uploaded anywhere?",
    answer: "No — everything runs in your browser. Nothing is sent to a server.",
    answerText: "No — everything runs in your browser. Nothing is sent to a server.",
  },
  {
    question: "What file formats are supported?",
    answer:
      "STEP, IGES, STL, OBJ, 3MF, BREP, GLB, and DXF for import; PDF for the generated drawing.",
    answerText:
      "STEP, IGES, STL, OBJ, 3MF, BREP, GLB, and DXF for import; PDF for the generated drawing.",
  },
];

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQS.map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: faq.answerText,
    },
  })),
};

export default function StepFileTo2dDrawing() {
  return (
    <>
      <Head>
        <title>
          How to Turn a STEP File into a 2D Engineering Drawing (Free) |
          CAD Viewer
        </title>
        <meta
          name="description"
          content="Generate a fully dimensioned 2D engineering drawing from any STEP, IGES, or STL file — free, in your browser, no SolidWorks or Fusion required."
        />
        <link
          rel="canonical"
          href="https://cadviewer.xyz/guides/step-file-to-2d-drawing"
        />
        <meta
          property="og:title"
          content="How to Turn a STEP File into a 2D Engineering Drawing (Free)"
        />
        <meta
          property="og:description"
          content="Generate a fully dimensioned 2D engineering drawing from any STEP, IGES, or STL file — free, in your browser, no SolidWorks or Fusion required."
        />
        <meta
          property="og:url"
          content="https://cadviewer.xyz/guides/step-file-to-2d-drawing"
        />
        <meta property="og:type" content="article" />
        <meta
          name="twitter:title"
          content="How to Turn a STEP File into a 2D Engineering Drawing (Free)"
        />
        <meta
          name="twitter:description"
          content="Generate a fully dimensioned 2D engineering drawing from any STEP, IGES, or STL file — free, in your browser, no SolidWorks or Fusion required."
        />
        <body className="guide-page" />
        <script type="application/ld+json">
          {JSON.stringify(FAQ_JSON_LD)}
        </script>
      </Head>
      <main className={styles.page}>
        <article className={styles.article}>
          <section className={styles.section}>
            <Link to="/" className={styles.breadcrumb}>
              ← Back to CAD Viewer
            </Link>
            <p className={styles.eyebrow}>Guide</p>
            <h1 className={styles.headline}>
              How to Turn a STEP File into a 2D Engineering Drawing — Free
            </h1>
          </section>

          <section className={styles.section}>
            <p className={styles.intro}>
              <em>No SolidWorks. No Fusion 360. No install.</em>
            </p>

            <p className={styles.lede}>
              If you've got a 3D model and need an actual engineering
              drawing from it — the kind with dimensions, a title block, and
              a scale you can hand to a machine shop — the usual answer is
              "open it in SolidWorks or Fusion 360." That's fine if you
              already have a seat. If you don't, there hasn't really been a
              free way to do this without installing something.
            </p>

            <p className={styles.lede}>
              Here's how to do it directly in your browser, in about a
              minute.
            </p>

            <div className={styles.ctaRow}>
              <a className={styles.cta} href="/viewer">
                Try it now — upload your STEP file
              </a>
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>How to do it</h2>
            <ol className={styles.stepList}>
              <li className={styles.stepCard}>
                <span className={styles.stepNumber}>1</span>
                <div className={styles.stepBody}>
                  <p className={styles.stepTitle}>{STEPS[0].title}</p>
                  <p className={styles.stepDescription}>
                    {STEPS[0].description}
                  </p>
                </div>
              </li>

              <li className={styles.stepCard}>
                <span className={styles.stepNumber}>2</span>
                <div className={styles.stepBody}>
                  <p className={styles.stepTitle}>{STEPS[1].title}</p>
                  <p className={styles.stepDescription}>
                    {STEPS[1].description}
                  </p>
                </div>
              </li>
            </ol>

            <div className={styles.stepImageWrap}>
              <img
                src="/guides/step-file-to-2d-drawing-3d-view.png"
                alt="CAD Viewer's 3D viewer showing an uploaded Pump Housing Face Plate STEP file with the Generate 2D Drawing button highlighted in the side panel"
                width={2000}
                height={1080}
                loading="lazy"
                style={{ width: "100%", height: "auto", borderRadius: "8px" }}
              />
            </div>

            <ol className={styles.stepList} start={3}>
              <li className={styles.stepCard}>
                <span className={styles.stepNumber}>3</span>
                <div className={styles.stepBody}>
                  <p className={styles.stepTitle}>{STEPS[2].title}</p>
                  {STEPS[2].description}
                </div>
              </li>
            </ol>

            <div className={styles.stepImageWrap}>
              <img
                src="/guides/step-file-to-2d-drawing-editor.png"
                alt="CAD Viewer's 2D drawing editor showing a fully dimensioned Front, Top, and Right orthographic drawing with an isometric reference view, notes, and title block"
                width={2000}
                height={1158}
                loading="lazy"
                style={{ width: "100%", height: "auto", borderRadius: "8px" }}
              />
            </div>

            <ol className={styles.stepList} start={4}>
              <li className={styles.stepCard}>
                <span className={styles.stepNumber}>4</span>
                <div className={styles.stepBody}>
                  <p className={styles.stepTitle}>{STEPS[3].title}</p>
                  <p className={styles.stepDescription}>
                    {STEPS[3].description}
                  </p>
                </div>
              </li>
            </ol>

            <div className={styles.videoWrap}>
              <iframe
                src="https://www.youtube.com/embed/-UKKipO4Rlw"
                title="Generating a 2D engineering drawing from a STEP file in CAD Viewer"
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>Why this exists</h2>
            <p className={styles.paragraph}>
              Free CAD viewers are common now — you can find plenty that'll
              just show you a model. Actually dimensioning it correctly
              (avoiding duplicate or overlapping dimensions, choosing a sane
              scale, keeping third-angle projection alignment right) turned
              out to be a much harder problem than the viewer itself, which
              is probably why nobody's given it away for free before.
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>Frequently asked</h2>
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
          </section>

          <section className={styles.section}>
            <div className={styles.ctaRow}>
              <a className={styles.cta} href="/viewer">
                Try it now — upload your STEP file
              </a>
            </div>
          </section>
        </article>
      </main>
    </>
  );
}
