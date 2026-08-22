import { lazy, Suspense } from "react";
import { ClientOnly, Head, ViteReactSSG } from "vite-react-ssg";
import type { RouteRecord } from "vite-react-ssg";
import Landing from "./pages/Landing";
import SplitStepAssembly from "./pages/guides/SplitStepAssembly";
import StepFileTo2dDrawing from "./pages/guides/StepFileTo2dDrawing";

const App = lazy(() => import("./ui/App"));

function ViewerLoading() {
  return (
    <div
      style={{
        background: "#e2e8f0",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "monospace",
        color: "#64748b",
      }}
    >
      Loading viewer…
    </div>
  );
}

function NotFound() {
  return (
    <div
      style={{
        color: "#fff",
        background: "#0d0f12",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "monospace",
      }}
    >
      <h1 style={{ fontSize: "4rem", margin: 0 }}>404</h1>
      <p style={{ color: "#6b7280" }}>Page not found.</p>
      <a href="/" style={{ color: "#3b82f6", marginTop: "1rem" }}>
        ← Go home
      </a>
    </div>
  );
}

export const routes: RouteRecord[] = [
  { path: "/", element: <Landing /> },
  { path: "/guides/split-step-assembly", Component: SplitStepAssembly },
  {
    path: "/guides/step-file-to-2d-drawing",
    Component: StepFileTo2dDrawing,
  },
  {
    path: "/viewer",
    element: (
      <>
        <Head>
          <title>CAD Viewer — 3D Viewer</title>
        </Head>
        <ClientOnly>
          {() => (
            <Suspense fallback={<ViewerLoading />}>
              <App />
            </Suspense>
          )}
        </ClientOnly>
      </>
    ),
  },
  { path: "*", element: <NotFound /> },
];

export const createRoot = ViteReactSSG({ routes });
