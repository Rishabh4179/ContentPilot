import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App.jsx";
import Layout from "./Layout.jsx";
import Library from "./pages/Library.jsx";
import Agent from "./pages/Agent.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import "./styles.css";

const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

const router = (
  <BrowserRouter>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<App />} />
        <Route path="library" element={<Library />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="agent" element={<Agent />} />
      </Route>
    </Routes>
  </BrowserRouter>
);

const tree = clerkKey ? (
  <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/">
    {router}
  </ClerkProvider>
) : (
  router
);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>{tree}</React.StrictMode>
);

