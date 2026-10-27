import { useState } from "react";
import { api, type User } from "../api";

export function Login({ onAuthed }: { onAuthed: (u: User) => void }) {
	const [mode, setMode] = useState<"login" | "signup">("login");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			const r = await api.post(`/api/auth/${mode}`, { username, password, displayName });
			onAuthed(r.user);
		} catch (err: any) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="auth">
			<div className="auth-art">
				<div className="orb" />
				<div className="row" style={{ gap: 12, position: "relative" }}>
					<div className="brand" style={{ padding: 0 }}>
						<div className="logo"><img src="/outpost.svg" width="30" height="30" alt="" /></div>
						<div className="name">Outpost</div>
					</div>
				</div>
				<h1 style={{ position: "relative" }}>
					Your workspace.
					<br />
					Your <em>agents.</em>
				</h1>
				<div className="table">
					<span>missions</span>
					<b>Give a team a goal. Review what it builds.</b>
					<span>modules</span>
					<b>Personal apps you and your agents use together.</b>
					<span>airlocks</span>
					<b>Control access. Approve external changes.</b>
					<span>blueprints</span>
					<b>Start from a template. Make it your own.</b>
					<span>your server</span>
					<b>Self-hosted. Built on pi-durable.</b>
				</div>
			</div>
			<div className="auth-form">
				<form onSubmit={submit}>
					<h2>{mode === "login" ? "Welcome back" : "Create your account"}</h2>
					<input className="input" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
					{mode === "signup" && <input className="input" placeholder="display name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
					<input className="input" type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
					{error && <div className="err">{error}</div>}
					<button className="btn primary" disabled={busy} style={{ justifyContent: "center", padding: "10px" }}>
						{mode === "login" ? "Sign in" : "Create account"}
					</button>
					<button type="button" className="btn ghost" onClick={() => setMode(mode === "login" ? "signup" : "login")} style={{ justifyContent: "center" }}>
						{mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}
					</button>
				</form>
			</div>
		</div>
	);
}
