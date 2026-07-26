import { ClientOnly, Head, ViteReactSSG } from "vite-react-ssg";
import type { RouteRecord } from "vite-react-ssg";
import App from "./ui/App";
import Landing from "./pages/Landing";

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
  {
    path: "/viewer",
    element: (
      <>
        <Head>
          <title>CAD Viewer — 3D Viewer</title>
        </Head>
        <ClientOnly>{() => <App />}</ClientOnly>
      </>
    ),
  },
  { path: "*", element: <NotFound /> },
];

export const createRoot = ViteReactSSG({ routes });
