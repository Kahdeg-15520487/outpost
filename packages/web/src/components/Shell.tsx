import { useEffect, useMemo, useState } from "react";
import { api, type Gadget, type ModelInfo, type ModelRef, type User, type Workspace } from "../api";
import { chatHref, navigate, timeAgo, useRoute, useSocketStatus, useWorkspace } from "../store";
import { socket } from "../socket";
import { ChatView } from "./Chat";
import { GadgetWindow } from "./GadgetWindow";
import { ApprovalsDrawer } from "./Approvals";
import { BlueprintsPage } from "./Blueprints";
import { SettingsPage } from "./Settings";
import { Avatar } from "./bits";

export function Shell({ user, onSignOut }: { user: User; onSignOut: () => void }) {
	const route = useRoute();
	const online = useSocketStatus();
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
	const [shared, setShared] = useState<Gadget[]>([]);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [defaultModel, setDefaultModel] = useState<ModelRef>();
	const [drawer, setDrawer] = useState(false);

	const loadWorkspaces = () => api.get("/api/workspaces").then((r) => setWorkspaces(r.workspaces));
	const loadShared = () => api.get("/api/shared").then((r) => setShared(r.gadgets));
	useEffect(() => {
		loadWorkspaces();
		loadShared();
		return socket.on((m) => m.t === "shared.changed" && loadShared());
	}, []);

	const wsId = "ws" in route ? route.ws : workspaces[0]?.id;
	useEffect(() => {
		if (route.page === "home" && workspaces[0]) navigate(chatHref(workspaces[0].id));
	}, [route.page, workspaces]);

	const ws = workspaces.find((w) => w.id === wsId);

	// The model list depends on configured keys, and the default on workspace settings: reload on
	// workspace switch, on focus (keys may have been added elsewhere), and after Settings changes.
	const loadModels = () =>
		api.get(`/api/models${wsId ? `?ws=${wsId}` : ""}`).then((r) => {
			setModels(r.models);
			setDefaultModel(r.default);
		});
	useEffect(() => {
		loadModels();
		addEventListener("focus", loadModels);
		return () => removeEventListener("focus", loadModels);
	}, [wsId]);
	const { docs, gadgets } = useWorkspace(ws?.id);
	const chats = useMemo(() => Object.values(docs.chats.chats).filter((c) => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt), [docs.chats]);
	const pending = Object.values(docs.approvals.actions).filter((a) => a.status === "pending").length + Object.values(docs.grants.requests).filter((r) => r.status === "pending").length;

	const newChat = async () => {
		if (!ws) return;
		const r = await api.post(`/api/w/${ws.id}/chats`, {});
		navigate(chatHref(ws.id, r.id));
	};
	const newWorkspace = async () => {
		const name = prompt("Name the new workspace");
		if (!name) return;
		const r = await api.post("/api/workspaces", { name });
		await loadWorkspaces();
		navigate(chatHref(r.workspace.id));
	};

	const gadgetOpen = route.page === "chat" && route.gadget;
	const canEdit = ws?.role !== "viewer";

	return (
		<div className={`shell ${gadgetOpen ? "with-gadget" : ""}`}>
			<aside className="sidebar">
				<div className="brand">
					<div className="logo">π</div>
					<div className="name">
						pi<em>·</em>os
					</div>
					<div className="kernel" title={online ? "Connected to the kernel" : "Reconnecting…"}>
						<span className={`dot ${online ? "" : "off"}`} />
						{online ? "live" : "…"}
					</div>
				</div>
				<div className="ws-switch">
					<select value={wsId ?? ""} onChange={(e) => (e.target.value === "__new" ? newWorkspace() : navigate(chatHref(e.target.value)))}>
						{workspaces.map((w) => (
							<option key={w.id} value={w.id}>
								{w.name}
								{w.role !== "owner" ? ` (${w.role})` : ""}
							</option>
						))}
						<option value="__new">+ New workspace…</option>
					</select>
				</div>
				{canEdit && (
					<div className="new-chat">
						<button onClick={newChat}>+ New chat</button>
					</div>
				)}
				<div className="side-scroll">
					<div className="side-section">
						<a className={`side-item ${drawer ? "on" : ""}`} href="#" onClick={(e) => (e.preventDefault(), setDrawer(true))}>
							<span className="ico">⚑</span>
							<span className="t">Approvals & access</span>
							{pending > 0 && <span className="badge">{pending}</span>}
						</a>
						{ws && (
							<>
								<a className={`side-item ${route.page === "blueprints" ? "on" : ""}`} href={`#/w/${ws.id}/blueprints`}>
									<span className="ico">❖</span>
									<span className="t">Blueprints</span>
								</a>
								<a className={`side-item ${route.page === "settings" ? "on" : ""}`} href={`#/w/${ws.id}/settings`}>
									<span className="ico">⚙</span>
									<span className="t">Settings</span>
								</a>
							</>
						)}
					</div>
					<div className="side-section">
						<div className="label">
							<span>Chats</span>
							<span>{chats.length || ""}</span>
						</div>
						{chats.length === 0 && <div className="side-item muted" style={{ color: "#6c6655" }}>No chats yet</div>}
						{ws &&
							chats.map((c) => (
								<a key={c.id} className={`side-item ${route.page === "chat" && route.chat === c.id ? "on" : ""}`} href={chatHref(ws.id, c.id, route.page === "chat" ? route.gadget : undefined)}>
									<span className="t">{c.title}</span>
									<span className="ago">{timeAgo(c.updatedAt)}</span>
								</a>
							))}
					</div>
					<div className="side-section">
						<div className="label">
							<span>Gadgets</span>
							<span>{gadgets.length || ""}</span>
						</div>
						{gadgets.length === 0 && <div className="side-item" style={{ color: "#6c6655" }}>Ask the agent to build one</div>}
						{ws &&
							gadgets.map((g) => (
								<a key={g.id} className={`side-item ${route.page === "chat" && route.gadget === g.id ? "on" : ""}`} href={chatHref(ws.id, route.page === "chat" ? route.chat : undefined, g.id)}>
									<span className="ico">{g.icon}</span>
									<span className="t">{g.name}</span>
								</a>
							))}
					</div>
					{shared.length > 0 && (
						<div className="side-section">
							<div className="label">
								<span>Shared with me</span>
							</div>
							{shared.map((g) => (
								<a key={g.id} className={`side-item ${route.page === "gadget" && route.gadget === g.id ? "on" : ""}`} href={`#/g/${g.id}`}>
									<span className="ico">{g.icon}</span>
									<span className="t">{g.name}</span>
									<span className="ago">{g.role}</span>
								</a>
							))}
						</div>
					)}
				</div>
				<div className="side-foot">
					<Avatar name={user.displayName} />
					<span className="who">{user.displayName}</span>
					<button onClick={onSignOut}>Sign out</button>
				</div>
			</aside>

			{route.page === "chat" && ws && <ChatView key={`${ws.id}:${route.chat ?? ""}`} ws={ws} chatId={route.chat} chats={docs.chats.chats} models={models} defaultModel={defaultModel} grants={docs.grants} openGadget={route.gadget} onNewChat={newChat} />}
			{route.page === "chat" && ws && route.gadget && (
				<GadgetWindow key={route.gadget} gadgetId={route.gadget} user={user} grants={docs.grants} onClose={() => navigate(chatHref(ws.id, route.chat))} />
			)}
			{route.page === "blueprints" && ws && <BlueprintsPage ws={ws} />}
			{route.page === "settings" && ws && <SettingsPage ws={ws} onChanged={() => (loadWorkspaces(), loadModels())} />}
			{route.page === "gadget" && (
				<div className="main" style={{ display: "flex" }}>
					<GadgetWindow key={route.gadget} gadgetId={route.gadget} user={user} grants={docs.grants} standalone onClose={() => navigate("#/")} />
				</div>
			)}
			{(route.page === "home" || route.page === "link") && <div className="main" />}

			{drawer && ws && <ApprovalsDrawer ws={ws} docs={docs} gadgets={gadgets} onClose={() => setDrawer(false)} />}
		</div>
	);
}
