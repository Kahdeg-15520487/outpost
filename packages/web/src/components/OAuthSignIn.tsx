import { useEffect, useRef, useState } from "react";
import { api } from "../api";

export type LoginView = {
	provider: string;
	status: "running" | "done" | "error" | "cancelled";
	prompt?: { id: number; type: "text" | "secret" | "manual_code" | "select"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] };
	deviceCode?: { userCode: string; verificationUri: string; expiresAt?: number };
	authUrl?: { url: string; instructions?: string };
	progress?: string;
	error?: string;
	startedBy: string;
};

/**
 * Drives a server-side OAuth sign-in (pi-ai's provider login flow): answers its prompts,
 * shows the device code to enter on the provider's site, and reports the outcome.
 */
export function OAuthSignIn({ provider, initial, onFinished, onClose }: { provider: string; initial?: LoginView | null; onFinished: () => void; onClose: () => void }) {
	const [login, setLogin] = useState<LoginView | null | undefined>(initial);
	const [answer, setAnswer] = useState("");
	const [err, setErr] = useState("");
	const [copied, setCopied] = useState(false);
	const [now, setNow] = useState(Date.now());
	const finished = useRef(false);
	const base = `/api/providers/${provider}/oauth`;

	// Start (or join an in-flight sign-in), then poll while it runs.
	useEffect(() => {
		let live = true;
		if (!initial || initial.status !== "running") api.post(base, {}).then((r) => live && setLogin(r.login), (e) => live && setErr(e.message));
		const t = setInterval(() => {
			setNow(Date.now());
			api.get(base).then((r) => live && setLogin(r.login), () => {});
		}, 1500);
		return () => {
			live = false;
			clearInterval(t);
		};
	}, [provider]);

	useEffect(() => {
		if (login?.status === "done" && !finished.current) {
			finished.current = true;
			onFinished();
		}
	}, [login?.status]);

	const send = async (value: string) => {
		if (!login?.prompt) return;
		setErr("");
		try {
			setLogin((await api.post(`${base}/answer`, { promptId: login.prompt.id, value })).login);
			setAnswer("");
		} catch (e: any) {
			setErr(e.message);
		}
	};
	const cancel = async () => {
		await api.post(`${base}/cancel`, {}).catch(() => {});
		onClose();
	};
	const restart = async () => {
		setErr("");
		finished.current = false;
		api.post(base, {}).then((r) => setLogin(r.login), (e) => setErr(e.message));
	};
	const copy = async (code: string) => {
		await navigator.clipboard?.writeText(code).catch(() => {});
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	const running = login?.status === "running";
	const left = login?.deviceCode?.expiresAt ? Math.max(0, Math.round((login.deviceCode.expiresAt - now) / 1000)) : undefined;

	return (
		<div className="oauth" role="group" aria-label="Sign in">
			{!login && !err && <div className="oauth-progress">Starting sign-in…</div>}

			{running && login?.prompt && (
				<form
					className="oauth-prompt"
					onSubmit={(e) => {
						e.preventDefault();
						send(answer);
					}}
				>
					<label className="label">{login.prompt.message}</label>
					{login.prompt.type === "select" ? (
						<div className="row" style={{ flexWrap: "wrap" }}>
							{login.prompt.options?.map((o) => (
								<button type="button" key={o.id} className="btn small" title={o.description} onClick={() => send(o.id)}>
									{o.label}
								</button>
							))}
						</div>
					) : (
						<div className="row">
							<input className="input grow mono" type={login.prompt.type === "secret" ? "password" : "text"} placeholder={login.prompt.placeholder} value={answer} onChange={(e) => setAnswer(e.target.value)} autoFocus />
							<button className="btn primary small">Continue</button>
						</div>
					)}
				</form>
			)}

			{running && login?.deviceCode && !login.prompt && (
				<div className="oauth-device">
					<div className="oauth-step">
						<span className="oauth-n">1</span> Copy this code
					</div>
					<button type="button" className="oauth-code" onClick={() => copy(login.deviceCode!.userCode)} title="Copy">
						{login.deviceCode.userCode}
						<span className="oauth-copy">{copied ? "copied ✓" : "copy"}</span>
					</button>
					<div className="oauth-step">
						<span className="oauth-n">2</span> Paste it on GitHub and approve
					</div>
					<a className="btn primary small" href={login.deviceCode.verificationUri} target="_blank" rel="noreferrer noopener" onClick={() => copy(login.deviceCode!.userCode)}>
						Open {new URL(login.deviceCode.verificationUri).host}
						{new URL(login.deviceCode.verificationUri).pathname} ↗
					</a>
				</div>
			)}

			{running && login?.authUrl && !login.deviceCode && !login.prompt && (
				<div className="oauth-device">
					<a className="btn primary small" href={login.authUrl.url} target="_blank" rel="noreferrer noopener">
						Open sign-in page ↗
					</a>
					{login.authUrl.instructions && <div className="muted">{login.authUrl.instructions}</div>}
				</div>
			)}

			{running && login?.progress && !login.prompt && (
				<div className="oauth-progress">
					<span className="oauth-spin" aria-hidden /> {login.progress}
					{left !== undefined && <span className="mono muted"> · code expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>}
				</div>
			)}

			{login?.status === "done" && <div className="oauth-done">Signed in ✓ — models from this account are now in the picker.</div>}
			{login?.status === "cancelled" && <div className="muted">Sign-in cancelled.</div>}
			{(login?.status === "error" || err) && <div className="err">{err || login?.error}</div>}

			<div className="row" style={{ justifyContent: "flex-end" }}>
				{running ? (
					<button type="button" className="btn ghost small" onClick={cancel}>
						Cancel
					</button>
				) : (
					<>
						{login?.status !== "done" && (
							<button type="button" className="btn small" onClick={restart}>
								Try again
							</button>
						)}
						<button type="button" className="btn ghost small" onClick={onClose}>
							Close
						</button>
					</>
				)}
			</div>
		</div>
	);
}
