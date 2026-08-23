import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Head } from "vite-react-ssg";
import AccordionItem from "../../components/AccordionItem";
import CornerMark from "../../components/CornerMark";
import Reveal from "../../components/Reveal";
import styles from "./SplitStepAssembly.module.css";

const MARK_STAGGER_MS = 130;
const cardMarkDelay = (index: number, offset: number) =>
  index * 90 + offset;

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

const WHY_REASONS = [
  "Quoting a single part — a supplier or machine shop only needs the one component you're sending out, not your entire 89-part assembly",
  "3D printing one piece — you only want to print the bracket, not the whole mechanism it belongs to",
  "Reusing a part — pulling one standard component out of an assembly to use in a new project",
  "Sharing without exposing the whole design — sending a single part without handing over your full assembly",
];

const PAINFUL_WAYS: ReactNode[] = [
  <>
    <ExternalLink href="https://www.solidworks.com">SolidWorks</ExternalLink>{" "}
    requires manually converting each body into a component first — and it
    commonly breaks on sheet-metal bodies with flanges
  </>,
  <>
    <ExternalLink href="https://plm.sw.siemens.com/en-US/nx/">
      Siemens NX
    </ExternalLink>{" "}
    requires digging into the Export STEP dialog's Advanced tab and manually
    enabling "External References"
  </>,
  <>
    Third-party converters (like{" "}
    <ExternalLink href="https://www.reaconverter.com">
      reaConverter
    </ExternalLink>
    ) can do it, but they're paid desktop software you have to install
  </>,
  'None of the common free "online STEP viewers" actually offer this — most only let you look at the file, not pull parts out of it',
];

const HOW_TO_STEPS = [
  {
    title: "Upload your assembly",
    description:
      "Go to cadviewer.xyz and drop in your assembly STEP file (or click to upload)",
  },
  {
    title: "Auto-detect the parts",
    description:
      "The viewer automatically detects it's a multi-part assembly and shows every component",
  },
  {
    title: "Disassemble the view",
    description:
      "Use the disassemble view to visually separate the parts from each other",
  },
  {
    title: "Select the part you need",
    description: "Click the specific part you need",
  },
  {
    title: "Export it",
    description:
      "Download it — it exports as its own clean, standalone STEP file, ready to send anywhere",
  },
];

const FAQS = [
  {
    question: "Is this actually free?",
    answer: "Yes — no signup, no subscription, no watermark on exported files.",
  },
  {
    question: "Does it work with sheet-metal assemblies?",
    answer:
      "Yes — unlike the common SolidWorks workaround, sheet-metal bodies with flanges aren't a special case here.",
  },
  {
    question: "What file formats can I upload?",
    answer:
      "STEP, IGES, STL, OBJ, 3MF, BREP, and GLB. STEP and IGES are the ones that carry true assembly/part structure, so those are the best fit for this specific use.",
  },
  {
    question: "Do I need to install anything?",
    answer: "No — it runs entirely in your browser.",
  },
  {
    question: "Is there a file size or part-count limit?",
    answer:
      "No fixed limit like most free viewers (which typically cap uploads at 200–300MB). Larger or more complex assemblies automatically switch to a lighter rendering mode to stay smooth, rather than rejecting the file outright.",
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
      text: faq.answer,
    },
  })),
};

export default function SplitStepAssembly() {
  const earlySteps = HOW_TO_STEPS.slice(0, 4);
  const laterSteps = HOW_TO_STEPS.slice(4);

  return (
    <>
      <Head>
        <title>
          How to Split a STEP Assembly Into Separate Part Files (Free,
          Online) | CAD Viewer
        </title>
        <meta
          name="description"
          content="Split a STEP assembly into individual part files free, online, no CAD software. Export each component as its own STEP file in three clicks."
        />
        <link
          rel="canonical"
          href="https://cadviewer.xyz/guides/split-step-assembly"
        />
        <meta
          property="og:title"
          content="How to Split a STEP Assembly Into Separate Part Files (Free)"
        />
        <meta
          property="og:description"
          content="Split a STEP assembly into individual part files free, online, no CAD software required."
        />
        <meta
          property="og:url"
          content="https://cadviewer.xyz/guides/split-step-assembly"
        />
        <meta property="og:type" content="article" />
        <meta
          name="twitter:title"
          content="How to Split a STEP Assembly Into Separate Part Files (Free)"
        />
        <meta
          name="twitter:description"
          content="Split a STEP assembly into individual part files free, online, no CAD software required."
        />
        <body className="guide-page" />
        <script type="application/ld+json">
          {JSON.stringify(FAQ_JSON_LD)}
        </script>
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
            <p className={styles.eyebrow}>Guide</p>
            <h1 className={styles.headline}>
              How to Split a STEP Assembly Into Separate Part Files (Free,
              Online)
            </h1>
          </section>

          <section className={styles.section}>
            <p className={styles.intro}>
              <em>No CAD software. No SolidWorks tricks. No install.</em>
            </p>

            <p className={styles.lede}>
              If you've ever had an assembly STEP file with dozens of parts
              and needed to send just one component to a machine shop, 3D
              print a single bracket, or reuse one part in a different
              design — you already know how annoying this usually is. Most
              CAD software makes you fight through multi-step export
              dialogs, and some (like SolidWorks) simply refuse to separate
              sheet-metal bodies at all without a workaround.
            </p>

            <p className={styles.lede}>
              CAD Viewer does this in three clicks, for free, directly in
              your browser.
            </p>

            <div className={styles.ctaRow}>
              <a className={styles.cta} href="/viewer">
                Try it now — upload your STEP file
              </a>
            </div>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>
              Why you'd need to do this
            </h2>
            <ul className={styles.cardList}>
              {WHY_REASONS.map((reason, index) => (
                <Reveal
                  as="li"
                  className={`${styles.reasonCard} cornerMarkSharpen`}
                  key={reason}
                  delayMs={index * 70}
                >
                  <CornerMark
                    corner="top-left"
                    animate
                    delay={cardMarkDelay(index, 0)}
                  />
                  <CornerMark
                    corner="bottom-right"
                    animate
                    delay={cardMarkDelay(index, MARK_STAGGER_MS)}
                  />
                  {reason}
                </Reveal>
              ))}
            </ul>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>
              The usual (painful) ways
            </h2>
            <p className={styles.paragraph}>
              Most CAD tools technically support this, but it's rarely
              simple:
            </p>
            <ul className={styles.list}>
              {PAINFUL_WAYS.map((way, index) => (
                <li key={index}>{way}</li>
              ))}
            </ul>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>
              How to do it with CAD Viewer
            </h2>
            <ol className={styles.stepList}>
              {earlySteps.map((step, index) => (
                <Reveal
                  as="li"
                  className={`${styles.stepCard} cornerMarkSharpen`}
                  key={step.title}
                  delayMs={index * 70}
                >
                  <CornerMark
                    corner="top-left"
                    animate
                    delay={cardMarkDelay(index, 0)}
                  />
                  <CornerMark
                    corner="bottom-right"
                    animate
                    delay={cardMarkDelay(index, MARK_STAGGER_MS)}
                  />
                  <span className={styles.stepNumber}>{index + 1}</span>
                  <div className={styles.stepBody}>
                    <p className={styles.stepTitle}>{step.title}</p>
                    <p className={styles.stepDescription}>
                      {step.description}
                    </p>
                  </div>
                </Reveal>
              ))}
            </ol>

            <div className={styles.stepImageWrap}>
              <CornerMark corner="top-left" animate delay={0} />
              <CornerMark
                corner="bottom-right"
                animate
                delay={MARK_STAGGER_MS}
              />
              <img
                src="/guides/split-step-assembly-demo.png"
                alt="CAD Viewer showing a multi-part STEP assembly disassembled into separate components, with one part selected and ready to export as its own STEP file"
                width={1200}
                height={696}
                loading="lazy"
                style={{ width: "100%", height: "auto", borderRadius: "8px" }}
              />
            </div>

            <ol className={styles.stepList} start={earlySteps.length + 1}>
              {laterSteps.map((step, index) => (
                <Reveal
                  as="li"
                  className={`${styles.stepCard} cornerMarkSharpen`}
                  key={step.title}
                  delayMs={index * 70}
                >
                  <CornerMark
                    corner="top-left"
                    animate
                    delay={cardMarkDelay(earlySteps.length + index, 0)}
                  />
                  <CornerMark
                    corner="bottom-right"
                    animate
                    delay={cardMarkDelay(
                      earlySteps.length + index,
                      MARK_STAGGER_MS,
                    )}
                  />
                  <span className={styles.stepNumber}>
                    {earlySteps.length + index + 1}
                  </span>
                  <div className={styles.stepBody}>
                    <p className={styles.stepTitle}>{step.title}</p>
                    <p className={styles.stepDescription}>
                      {step.description}
                    </p>
                  </div>
                </Reveal>
              ))}
            </ol>

            <p className={styles.paragraph}>
              That's it. No install, no account, no software license.
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>Frequently asked</h2>
            <div className={styles.faqGrid}>
              {FAQS.map((faq, index) => (
                <Reveal as="div" key={faq.question} delayMs={index * 70}>
                  <AccordionItem
                    question={faq.question}
                    answer={faq.answer}
                    className="cornerMarkSharpen"
                  >
                    <CornerMark
                      corner="top-left"
                      animate
                      delay={cardMarkDelay(index, 0)}
                    />
                    <CornerMark
                      corner="bottom-right"
                      animate
                      delay={cardMarkDelay(index, MARK_STAGGER_MS)}
                    />
                  </AccordionItem>
                </Reveal>
              ))}
            </div>
          </section>
        </article>
      </main>

      <div className={styles.ctaBand}>
        <div className={styles.ctaBandInner}>
          <h2 className={styles.ctaBandHeading}>
            Ready to pull that part out?
          </h2>
          <div className={styles.ctaRow}>
            <a className={styles.cta} href="/viewer">
              Try it now — upload your STEP file
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
