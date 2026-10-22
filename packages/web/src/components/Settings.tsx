import { useEffect, useState } from "react";
import { api, type ModelInfo, type Workspace } from "../api";

type Provider = { id: string; name: string; configured: boolean; source?: string; editable: boolean; stored: boolean; oauthOnly: boolean; models: number };

export function SettingsPage({ ws, onChanged }: { ws: Workspace; onChanged: () => void }) {
	const [providers, setProviders] = useState<Provider[]>([]);
	const [cfg, setCfg] = useState<{ configPath: string; configFound: boolean; ambientEnv: boolean }>();
	const [keyErr, setKeyErr] = useState("");
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [members, setMembers] = useState<{ id: string; username: string; displayName: string; role: string }[]>([]);
	const [name, setName] = useState(ws.name);
	const [context, setContext] = useState(ws.settings.companyContext ?? "");
	const [toolMode, setToolMode] = useState(ws.settings.toolMode ?? "hybrid");
	const [defaultModel, setDefaultModel] = useState(ws.settings.defaultModel ? `${ws.settings.defaultModel.provider}/${ws.settings.defaultModel.modelId}` : "");
	const [saved, setSaved] = useState("");
	const [invite, setInvite] = useState({ username: "", role: "editor" });
	const [keyFor, setKeyFor] = useState<string>();
	const [key, setKey] = useState("");
	const [filter, setFilter] = useState("");
	const isOwner = ws.role === "owner";

	const loadProviders = () =>
		api.get("/api/providers").then((r) => {
			setProviders(r.providers);
			setCfg({ configPath: r.configPath, configFound: r.configFound, ambientEnv: r.ambientEnv });
		});
	const loadModels = () => api.get("/api/models").then((r) => setModels(r.models));
	const loadMembers = () => api.get(`/api/w/${ws.id}`).then((r) => setMembers(r.members));
	useEffect(() => {
		loadProviders();
		loadModels();
		loadMembers();
	}, [ws.id]);

	const save = async () => {
		const [provider, ...rest] = defaultModel.split("/");
		await api.patch(`/api/w/${ws.id}`, { name, settings: { companyContext: context, toolMode, defaultModel: defaultModel ? { provider, modelId: rest.join("/") } : undefined } });
		setSaved("Saved ✓");
		onChanged();
		setTimeout(() => setSaved(""), 2000);
	};

	return (
		<div className="main">
			<div className="page">
				<div className="page-inner">
					<h1>Settings</h1>
					<p className="lede">Workspace knowledge, the default model, who's in here, and which model providers this OS can use.</p>
					<div className="settings-grid">
						<div style={{ display: "grid", gap: 18 }}>
							<div className="card" style={{ display: "grid", gap: 10 }}>
								<h3 style={{ margin: 0, font: "600 17px var(--display)" }}>Workspace</h3>
								<label className="label">Name</label>
								<input className="input" value={name} disabled={!isOwner} onChange={(e) => setName(e.target.value)} />
								<label className="label">Company context</label>
								<textarea
									className="input"
									rows={7}
									disabled={!isOwner}
									value={context}
									onChange={(e) => setContext(e.target.value)}
									placeholder={"What every agent here should know: who you are, how you work, vocabulary, style rules…\n\ne.g. We're Acme Robotics. Fiscal year starts in February. Slides use our 'forest' theme."}
								/>
								<label className="label">Default model for new chats</label>
								<select className="input" value={defaultModel} disabled={!isOwner} onChange={(e) => setDefaultModel(e.target.value)}>
									<option value="">Automatic (models.default in config, else first available)</option>
									{models.map((m) => (
										<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
											{m.provider} · {m.name}
										</option>
									))}
								</select>
								<label className="label">Agent tools</label>
								<select className="input" value={toolMode} disabled={!isOwner} onChange={(e) => setToolMode(e.target.value as any)}>
									<option value="hybrid">Hybrid — direct tools + code mode</option>
									<option value="codemode">Code mode — the model writes scripts that call tools</option>
								</select>
								{isOwner && (
									<div className="row">
										<button className="btn primary" onClick={save}>
											Save
										</button>
										<span className="muted">{saved}</span>
									</div>
								)}
							</div>
							<div className="card">
								<h3 style={{ margin: "0 0 8px", font: "600 17px var(--display)" }}>Members</h3>
								{members.map((m) => (
									<div key={m.id} className="list-row">
										<span className="grow">
											{m.displayName} <span className="mono muted">@{m.username}</span>
										</span>
										<span className="pill">{m.role}</span>
										{isOwner && m.role !== "owner" && (
											<button className="btn ghost small" onClick={() => api.post(`/api/w/${ws.id}/members`, { username: m.username, role: null }).then(loadMembers)}>
												Remove
											</button>
										)}
									</div>
								))}
								{isOwner && (
									<form
										className="row"
										style={{ marginTop: 10 }}
										onSubmit={(e) => {
											e.preventDefault();
											api.post(`/api/w/${ws.id}/members`, invite).then(() => {
												setInvite({ ...invite, username: "" });
												loadMembers();
											}, (err) => alert(err.message));
										}}
									>
										<input className="input grow" placeholder="username" value={invite.username} onChange={(e) => setInvite({ ...invite, username: e.target.value })} />
										<select className="input" style={{ width: 100 }} value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
											<option>editor</option>
											<option>viewer</option>
										</select>
										<button className="btn">Add</button>
									</form>
								)}
								<div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
									Members share every chat (live, like a channel) and gadget in this workspace.
								</div>
							</div>
						</div>
						<div className="card">
							<h3 style={{ margin: "0 0 4px", font: "600 17px var(--display)" }}>Model providers</h3>
							<div className="muted" style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.55 }}>
								Every provider pi-ai supports. A key is taken from, in order: <b>{cfg?.configFound ? "" : "(missing) "}</b>
								<code className="mono">{cfg?.configPath}</code> → keys saved here (encrypted in the data dir)
								{cfg?.ambientEnv ? <> → the provider's standard env var</> : <> (ambient env vars disabled)</>}.
							</div>
							<input className="input" placeholder="Filter providers…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 8 }} />
							<div style={{ maxHeight: 520, overflowY: "auto" }}>
								{providers
									.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()))
									.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name))
									.map((p) => (
										<div key={p.id} className="list-row" style={{ flexWrap: "wrap" }}>
											<span className="grow">
												{p.name} <span className="mono muted" style={{ fontSize: 11 }}>{p.id} · {p.models} models</span>
												{p.source && (
													<div className="mono muted" style={{ fontSize: 11 }}>
														key from {p.source}
													</div>
												)}
											</span>
											{p.configured ? <span className="pill ok">ready</span> : <span className="pill">not set</span>}
											{p.oauthOnly ? (
												<span className="mono muted" style={{ fontSize: 11 }}>
													subscription login not supported
												</span>
											) : p.editable ? (
												<>
													{p.stored && (
														<button className="btn ghost small" onClick={() => api.post(`/api/providers/${p.id}/key`, { key: "" }).then(() => (loadProviders(), loadModels(), onChanged()))}>
															Remove
														</button>
													)}
													<button className="btn ghost small" onClick={() => (setKeyFor(keyFor === p.id ? undefined : p.id), setKey(""), setKeyErr(""))}>
														{p.stored ? "Change key" : "Add key"}
													</button>
												</>
											) : (
												<span className="pill" title="Set in the config file">
													config
												</span>
											)}
											{keyFor === p.id && (
												<form
													className="row"
													style={{ width: "100%", marginTop: 6 }}
													onSubmit={async (e) => {
														e.preventDefault();
														try {
															await api.post(`/api/providers/${p.id}/key`, { key });
															setKeyFor(undefined);
															loadProviders();
															loadModels();
															onChanged();
														} catch (err: any) {
															setKeyErr(err.message);
														}
													}}
												>
													<input className="input grow mono" type="password" placeholder="API key" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
													<button className="btn primary small">Save</button>
													{keyErr && <div className="err" style={{ width: "100%" }}>{keyErr}</div>}
												</form>
											)}
										</div>
									))}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
