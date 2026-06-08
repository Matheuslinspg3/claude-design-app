import { useState, useEffect } from "react";
import Login from "./pages/Login.jsx";
import Designer from "./pages/Designer.jsx";

export default function App() {
  const [authed, setAuthed] = useState(null); // null = checking

  useEffect(() => {
    fetch("/api/auth").then(r => {
      setAuthed(r.ok);
    }).catch(() => setAuthed(false));
  }, []);

  if (authed === null) return null; // loading
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  return <Designer />;
}
