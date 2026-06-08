import { useState } from "react";

export default function Login({ onLogin }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault(); setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) { onLogin(); }
    else { setError("Senha incorreta"); }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Claude Design</h1>
        <p>Describe it. See it. Ship it.</p>
        {error && <p className="login-error">{error}</p>}
        <input className="login-input" type="password" placeholder="Password"
          value={password} onChange={e => setPassword(e.target.value)} autoFocus />
        <button className="login-btn" type="submit">Enter</button>
      </form>
    </div>
  );
}
