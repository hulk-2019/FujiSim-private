import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// @ts-ignore
import "./index.css";

const initialTheme = localStorage.getItem("fujisim-theme") || "light";
if (initialTheme === "dark") {
  document.documentElement.classList.add("dark");
} else {
  document.documentElement.classList.remove("dark");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
