import { lazy, Suspense } from "react";
import { usePath } from "./router";
import { Landing } from "./pages/Landing";

// The viewer page is split out so the landing and login pages stay tiny on a
// phone: the player — and hls.js behind it — only download when opened.
const Player = lazy(() => import("./pages/Player").then((m) => ({ default: m.Player })));
const Admin = lazy(() => import("./pages/Admin").then((m) => ({ default: m.Admin })));
const Login = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));

export function App() {
  const path = usePath();

  if (path === "/login")
    return (
      <Suspense fallback={null}>
        <Login />
      </Suspense>
    );
  if (path.startsWith("/live/")) {
    const slug = path.slice("/live/".length).replace(/\/+$/, "");
    return (
      <Suspense fallback={<div className="loading-page"><span className="spinner" /></div>}>
        <Player slug={slug} />
      </Suspense>
    );
  }
  if (path === "/admin" || path.startsWith("/admin/"))
    return (
      <Suspense fallback={<div className="loading-page"><span className="spinner" /></div>}>
        <Admin />
      </Suspense>
    );
  return <Landing />;
}
