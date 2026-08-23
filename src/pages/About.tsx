import { Link } from "react-router-dom";
import { Head } from "vite-react-ssg";
import styles from "./About.module.css";
import CornerMark from "../components/CornerMark";
import {
  BoltIllustration,
  BracketIllustration,
  CalipersIllustration,
} from "./illustrations";

const MARK_STAGGER_MS = 130;

export default function About() {
  return (
    <>
      <Head>
        <title>About CADViewer</title>
        <meta
          name="description"
          content="Why CADViewer exists, how it works, and who's building it."
        />
        <link rel="canonical" href="https://cadviewer.xyz/about" />
        <meta property="og:title" content="About CADViewer" />
        <meta
          property="og:description"
          content="Why CADViewer exists, how it works, and who's building it."
        />
        <meta property="og:url" content="https://cadviewer.xyz/about" />
        <meta property="og:type" content="website" />
        <meta name="twitter:title" content="About CADViewer" />
        <meta
          name="twitter:description"
          content="Why CADViewer exists, how it works, and who's building it."
        />
        <body className="about-page" />
      </Head>
      <main className={styles.page}>
        <article className={styles.article}>
          <section className={styles.section}>
            <CornerMark corner="top-left" animate delay={0} />
            <CornerMark
              corner="bottom-right"
              animate
              delay={MARK_STAGGER_MS}
            />
            <Link to="/" className={styles.breadcrumb}>
              ← Back to CAD Viewer
            </Link>
            <p className={styles.eyebrow}>About</p>
            <h1 className={styles.headline}>About CADViewer</h1>
          </section>

          <section className={styles.section}>
            <div className={styles.illustrationRow}>
              <div className={styles.illustrationText}>
                <h2 className={styles.sectionHeading}>Why this exists</h2>
                <p className={styles.paragraph}>
                  Viewing a CAD file usually means installing something —
                  SolidWorks, Fusion 360, or at minimum a dedicated viewer
                  app. If you just need to look at a STEP file someone sent
                  you, or turn a 3D model into a drawing you can hand to a
                  machine shop, that's a lot of friction for an occasional
                  task.
                </p>
                <p className={styles.paragraph}>
                  CADViewer is built to remove that friction: open the file
                  in a browser tab, view it, measure it, and generate a real
                  engineering drawing from it — no install, no account, no
                  cost.
                </p>
              </div>
              <BoltIllustration size={88} className={styles.illustration} />
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.illustrationRow}>
              <div className={styles.illustrationText}>
                <h2 className={styles.sectionHeading}>How it works</h2>
                <p className={styles.paragraph}>
                  The viewer runs on OpenCascade (OCCT), the open-source CAD
                  kernel, compiled to WebAssembly so it runs directly in your
                  browser. Your file is never uploaded to a server —
                  everything from geometry parsing to drawing generation
                  happens on your own machine.
                </p>
                <p className={styles.paragraph}>
                  The 2D drawing generator specifically follows standard
                  drafting convention — third-angle projection, proper
                  dimension placement, correct scale selection — rather than
                  just capturing a picture of the model from three angles.
                  Getting that right took real iteration; a drawing that
                  looks plausible but is missing a dimension or duplicates
                  one isn't actually useful to whoever has to build the part
                  from it.
                </p>
              </div>
              <CalipersIllustration
                size={88}
                className={styles.illustration}
              />
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>Who's building this</h2>
            <p className={styles.paragraph}>
              CADViewer is built and maintained by Devaraj, working solo.
              The project started from a simple frustration: needing to
              open and document CAD files without paying for a SolidWorks
              or Fusion 360 seat.
            </p>
            <p className={styles.paragraph}>
              Most of the implementation has been built through iterative,
              AI-assisted development — but every drafting decision, every
              dimensioning rule, and every generated drawing has been
              checked by hand against real drafting standards and tested on
              real parts before shipping. The goal was never just "does it
              run," it was "would this hold up if someone actually built
              the part from it."
            </p>
          </section>

          <section className={styles.section}>
            <div className={styles.illustrationRow}>
              <div className={styles.illustrationText}>
                <h2 className={styles.sectionHeading}>What's next</h2>
                <p className={styles.paragraph}>
                  Sheet-metal unfold and flattening, exploded assembly
                  views, and BOM tables are next on the list. And more
                  unexpected features to come.
                </p>
              </div>
              <BracketIllustration
                size={88}
                className={styles.illustration}
              />
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>Get in touch</h2>
            <p className={styles.paragraph}>
              Found a bug, or need a format that isn't supported yet?{" "}
              <a
                href="mailto:devarajhello@gmail.com"
                className={styles.externalLink}
              >
                Get in touch
              </a>
              .
            </p>
          </section>
        </article>
      </main>

      <div className={styles.ctaBand}>
        <div className={styles.ctaBandInner}>
          <h2 className={styles.ctaBandHeading}>See it on your own file</h2>
          <div className={styles.ctaRow}>
            <a className={styles.cta} href="/viewer">
              Try CADViewer now
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
