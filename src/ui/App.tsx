import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import LandingPage from "./LandingPage";
import ViewerPage from "./ViewerPage";
import "./App.css";

export default function App() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/viewer" element={<ViewerPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
