"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, LockKeyhole } from "lucide-react";
import { Logo } from "@/components/logo";

export function AdminLogin() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "Sign in failed.");
      router.push("/admin");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-glow" />
      <Link href="/" className="back-link">
        <ArrowLeft size={16} /> Back to assistant
      </Link>
      <section className="login-card">
        <Logo />
        <div className="login-icon">
          <LockKeyhole size={23} />
        </div>
        <p className="eyebrow">Administrator access</p>
        <h1>Welcome back.</h1>
        <p className="login-subtitle">
          Sign in to manage the sources Atlas can learn from.
        </p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="password">Admin password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter your password"
            autoFocus
          />
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={!password || loading}>
            {loading ? "Signing in..." : "Continue"}
            {!loading && <ArrowRight size={17} />}
          </button>
        </form>
      </section>
    </main>
  );
}
