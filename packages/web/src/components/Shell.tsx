import { useEffect, useMemo, useState } from "react";
import { api, type Gadget, type ModelInfo, type ModelRef, type User, type Workspace } from "../api";
import { chatHref, navigate, timeAgo, useRoute, useSocketStatus, useWorkspace } from "../store";
import { socket } from "../socket";
import { ChatView } from "./Chat";
import { GadgetWindow } from "./GadgetWindow";
import { ApprovalsDrawer } from "./Approvals";
import { BlueprintsPage } from "./Blueprints";
import { SettingsPage } from "./Settings";
import { FilesPage } from "./Files";
import { Avatar } from "./bits";
import { InlineRename, RowMenu } from "./RowMenu";
import { ModelPickerDialog, type ModelPicker } from "./ModelPicker";

export function Shell({ user, onSignOut }: { user: User; onSignOut: () => void }) {
	const route = useRoute();
	const online = useSocketStatus();
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
	const [shared, setShared] = useState<Gadget[]>([]);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [defaultModel, setDefaultModel] = useState<ModelRef>();
	const [picker, setPicker] = useState<ModelPicker>({});
	const [managingModels, setManagingModels] = useState(false);
	const [drawer, setDrawer] = useState(false);
	/** Which sidebar row is being renamed ("c:<id>" / "g:<id>"), and which row's menu is open (keeps its button visible). */
	const [renaming, setRenaming] = useState<string>();
	const [menuOpen, setMenuOpen] = useState<string>();
	/** Ask the gadget window to switch tabs (from the sidebar menu's "Share…"). */
	const [tabRequest, setTabRequest] = useState<{ gadget: string; tab: "share"; n: number }>();

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
			setPicker(r.picker ?? {});
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

	const copyLink = (hash: string) => navigator.clipboard?.writeText(`${location.origin}${location.pathname}${hash}`).catch(() => prompt("Copy this link", `${location.origin}${location.pathname}${hash}`));
	const archiveChat = async (id: string) => {
		if (!ws || !confirm("Archive this chat? It's removed from the sidebar for everyone in the workspace.")) return;
		await api.del(`/api/w/${ws.id}/chats/${id}`);
		if (route.page === "chat" && route.chat === id) navigate(chatHref(ws.id, undefined, route.gadget));
	};
	const deleteGadget = async (g: Gadget) => {
		if (!ws || !confirm(`Delete "${g.name}"? Its code and data are removed for everyone it's shared with.`)) return;
		await api.del(`/api/gadgets/${g.id}`).catch((e) => alert(e.message));
		if (route.page === "chat" && route.gadget === g.id) navigate(chatHref(ws.id, route.chat));
	};
	const rowClass = (key: string, on: boolean) => `side-row ${on ? "on" : ""} ${menuOpen === key ? "menu-open" : ""}`;

	const gadgetOpen = route.page === "chat" && route.gadget;
	const chatHidden = route.page === "chat" && !!route.gadget && !!route.focus;
	const canEdit = ws?.role !== "viewer";

	return (
		<div className={`shell ${gadgetOpen ? "with-gadget" : ""} ${chatHidden ? "chat-hidden" : ""}`}>
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
								<a className={`side-item ${route.page === "files" ? "on" : ""}`} href={`#/w/${ws.id}/files`}>
									<span className="ico">▤</span>
									<span className="t">Files</span>
									<span className="ago">{Object.values(docs.files.files).filter((f) => !f.parent).length || ""}</span>
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
							chats.map((c) => {
								const on = route.page === "chat" && route.chat === c.id;
								const href = chatHref(ws.id, c.id);
								return renaming === `c:${c.id}` ? (
									<div key={c.id} className="side-item editing">
										<InlineRename value={c.title} onSave={(title) => api.patch(`/api/w/${ws.id}/chats/${c.id}`, { title })} onDone={() => setRenaming(undefined)} />
									</div>
								) : (
									<div key={c.id} className={rowClass(`c:${c.id}`, on)}>
										<a
											className={`side-item ${on ? "on" : ""}`}
											href={chatHref(ws.id, c.id, route.page === "chat" ? route.gadget : undefined)}
											title={canEdit ? `${c.title} — double-click to rename` : c.title}
											onDoubleClick={canEdit ? (e) => (e.preventDefault(), getSelection()?.removeAllRanges(), setRenaming(`c:${c.id}`)) : undefined}
										>
											<span className="t">{c.title}</span>
											<span className="ago">{timeAgo(c.updatedAt)}</span>
										</a>
										<RowMenu
											label={c.title}
											onOpenChange={(o) => setMenuOpen(o ? `c:${c.id}` : undefined)}
											items={[
												{ label: "Rename", icon: "✎", onSelect: () => setRenaming(`c:${c.id}`), hidden: !canEdit },
												{ label: "Copy link", icon: "⧉", onSelect: () => copyLink(href) },
												{ label: "Archive", icon: "▭", onSelect: () => archiveChat(c.id), danger: true, hidden: !canEdit },
											]}
										/>
									</div>
								);
							})}
					</div>
					<div className="side-section">
						<div className="label">
							<span>Gadgets</span>
							<span>{gadgets.length || ""}</span>
						</div>
						{gadgets.length === 0 && <div className="side-item" style={{ color: "#6c6655" }}>Ask the agent to build one</div>}
						{ws &&
							gadgets.map((g) => {
								const on = route.page === "chat" && route.gadget === g.id;
								const canChange = g.role === "owner" || g.role === "editor";
								return renaming === `g:${g.id}` ? (
									<div key={g.id} className="side-item editing">
										<span className="ico">{g.icon}</span>
										<InlineRename value={g.name} onSave={(name) => api.patch(`/api/gadgets/${g.id}`, { name })} onDone={() => setRenaming(undefined)} />
									</div>
								) : (
									<div key={g.id} className={rowClass(`g:${g.id}`, on)}>
										<a
											className={`side-item ${on ? "on" : ""}`}
											href={chatHref(ws.id, route.page === "chat" ? route.chat : undefined, g.id, true)}
											title={canChange ? `${g.name} — double-click to rename` : g.name}
											onDoubleClick={canChange ? (e) => (e.preventDefault(), getSelection()?.removeAllRanges(), setRenaming(`g:${g.id}`)) : undefined}
										>
											<span className="ico">{g.icon}</span>
											<span className="t">{g.name}</span>
										</a>
										<RowMenu
											label={g.name}
											onOpenChange={(o) => setMenuOpen(o ? `g:${g.id}` : undefined)}
											items={[
												{ label: "Rename", icon: "✎", onSelect: () => setRenaming(`g:${g.id}`), hidden: !canChange },
												{ label: "Open full page", icon: "⤢", onSelect: () => navigate(`#/g/${g.id}`) },
												{
													label: "Share…",
													icon: "⇪",
													hidden: g.role !== "owner",
													onSelect: () => {
														navigate(chatHref(ws.id, route.page === "chat" ? route.chat : undefined, g.id, route.page === "chat" && route.gadget === g.id ? route.focus : true));
														setTabRequest((t) => ({ gadget: g.id, tab: "share", n: (t?.n ?? 0) + 1 }));
													},
												},
												{ label: "Copy link", icon: "⧉", onSelect: () => copyLink(`#/g/${g.id}`) },
												{ label: "Delete", icon: "✕", onSelect: () => deleteGadget(g), danger: true, hidden: g.role !== "owner" },
											]}
										/>
									</div>
								);
							})}
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

			{route.page === "chat" && ws && <ChatView key={`${ws.id}:${route.chat ?? ""}`} ws={ws} chatId={route.chat} chats={docs.chats.chats} models={models} defaultModel={defaultModel} grants={docs.grants} openGadget={route.gadget} gadget={gadgets.find((g) => g.id === route.gadget)} picker={picker} onManageModels={() => setManagingModels(true)} onNewChat={newChat} />}
			{route.page === "chat" && ws && route.gadget && (
				<GadgetWindow key={route.gadget} gadgetId={route.gadget} user={user} grants={docs.grants} tabRequest={tabRequest?.gadget === route.gadget ? tabRequest : undefined}
					chatHidden={chatHidden}
					onToggleChat={() => navigate(chatHref(ws.id, route.chat, route.gadget, !chatHidden))}
					onClose={() => navigate(chatHref(ws.id, route.chat))} />
			)}
			{route.page === "blueprints" && ws && <BlueprintsPage ws={ws} />}
			{route.page === "files" && ws && <FilesPage ws={ws} files={docs.files.files} gadgets={gadgets} />}
			{route.page === "settings" && ws && <SettingsPage ws={ws} onChanged={() => (loadWorkspaces(), loadModels())} onManageModels={() => setManagingModels(true)} />}
			{route.page === "gadget" && (
				<div className="main" style={{ display: "flex" }}>
					<GadgetWindow key={route.gadget} gadgetId={route.gadget} user={user} grants={docs.grants} standalone onClose={() => navigate("#/")} />
				</div>
			)}
			{(route.page === "home" || route.page === "link") && <div className="main" />}

			{managingModels && (
				<ModelPickerDialog
					models={models}
					picker={picker}
					onClose={() => setManagingModels(false)}
					onSave={async (next) => setPicker((await api.put("/api/me/model-picker", { picker: next })).picker)}
				/>
			)}
			{drawer && ws && <ApprovalsDrawer ws={ws} docs={docs} gadgets={gadgets} onClose={() => setDrawer(false)} />}
		</div>
	);
}
