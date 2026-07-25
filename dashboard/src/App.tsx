import { useEffect, useState } from "react";
import { DashboardPage } from "./pages/DashboardPage";
import { LandingPage } from "./pages/LandingPage";

function pathFromLocation(): string {
  return window.location.pathname.replace(/\/$/, "") || "/";
}

export default function App() {
  const [path, setPath] = useState(pathFromLocation);

  useEffect(() => {
    const onPop = () => setPath(pathFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = (next: string) => {
    const normalized = next.replace(/\/$/, "") || "/";
    if (normalized !== pathFromLocation()) {
      window.history.pushState({}, "", normalized);
    }
    setPath(normalized);
  };

  if (path === "/dashboard") {
    return <DashboardPage onHome={() => navigate("/")} />;
  }

  return <LandingPage onOpenDashboard={() => navigate("/dashboard")} />;
}
