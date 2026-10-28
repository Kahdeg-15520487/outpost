import { useEffect, useMemo, useState } from "react";
import { ConnectionsPage } from "./Connections";
import { exportModule } from "./Transfer";
import { api, type Module, type ModelInfo, type ModelRef, type User, type Workspace } from "../api";
import { chatHref, homeHref, navigate, missionHref, timeAgo, timeTitle, useRoute, useSocketStatus, useWorkspace, useConnections, useAppUpdated } from "../store";
import { startKeyboardNav } from "../keys";
import { socket } from "../socket";
import { ChatView } from "./Chat";
import { HomePage } from "./Home";
import { ModuleWindow } from "./ModuleWindow";
import { ApprovalsDrawer } from "./Approvals";
import { BlueprintsPage } from "./Blueprints";
import { SettingsPage } from "./Settings";
import { FilesPage } from "./Files";
import { UserMenu } from "./UserMenu";
import { InlineRename, RowMenu } from "./RowMenu";
import { ModelPickerDialog, type ModelPicker } from "./ModelPicker";
import { NewMissionDialog, MissionPage } from "./MissionPage";
import { askConfirm, askText, reportError } from "../dialogs";

export function Shell({ user, onSignOut }: { user: User; onSignOut: () => void }) {
	useEffect(() => startKeyboardNav(), []);
	const route = useRoute();
	const online = useSocketStatus();
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
	const [shared, setShared] = useState<Module[]>([]);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [defaultModel, setDefaultModel] = useState<ModelRef>();
	const [picker, setPicker] = useState<ModelPicker>({});
	const [managingModels, setManagingModels] = useState(false);
	const [newMission, setNewMission] = useState(false);
	const [drawer, setDrawer] = useState(false);
	/** The sidebar can be tucked away; the choice is remembered per browser. */
	const [collapsed, setCollapsed] = useState(() => localStorage.getItem("outpost.sidebar") === "collapsed");
	const [showArchived, setShowArchived] = useState(false);
	const setSidebar = (hide: boolean) => {
		setCollapsed(hide);
		localStorage.setItem("outpost.sidebar", hide ? "collapsed" : "open");
	};
	/** Which sidebar row is being renamed ("c:<id>" / "g:<id>"), and which row's menu is open (keeps its button visible). */
	const [renaming, setRenaming] = useState<string>();
	const [menuOpen, setMenuOpen] = useState<string>();
	/** Ask the module window to switch tabs (from the sidebar menu's "Share…"). */
	const [tabRequest, setTabRequest] = useState<{ module: string; tab: "share"; n: number }>();

	const loadWorkspaces = () => api.get("/api/workspaces").then((r) => setWorkspaces(r.workspaces));
	const loadShared = () => api.get("/api/shared").then((r) => setShared(r.modules));
	useEffect(() => {
		loadWorkspaces();
		loadShared();
		return socket.on((m) => m.t === "shared.changed" && loadShared());
	}, []);

	const wsId = "ws" in route ? route.ws : workspaces[0]?.id;
	useEffect(() => {
		// No workspace in the URL yet (the bare landing): go to the first one's homepage.
		if (route.page === "home" && !("ws" in route) && workspaces[0]) navigate(homeHref(workspaces[0].id));
	}, [route, workspaces]);

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
	const { docs, modules, archived, missions } = useWorkspace(ws?.id);
	const proposed = useConnections(ws?.id).proposals.filter((p) => p.status === "pending").length;
	const updated = useAppUpdated();
	const chats = useMemo(() => Object.values(docs.chats.chats).filter((c) => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt), [docs.chats]);
	const archivedChats = useMemo(() => Object.values(docs.chats.chats).filter((c) => c.archived).sort((a, b) => b.updatedAt - a.updatedAt), [docs.chats]);
	const canEditChats = ws?.role !== "viewer";
	const restoreChat = async (id: string) => {
		await api.patch(`/api/w/${ws!.id}/chats/${id}`, { archived: false });
	};
	const pending = Object.values(docs.approvals.actions).filter((a) => a.status === "pending").length + Object.values(docs.grants.requests).filter((r) => r.status === "pending").length;

	const newChat = async () => {
		if (!ws) return;
		const r = await api.post(`/api/w/${ws.id}/chats`, {});
		navigate(chatHref(ws.id, r.id));
	};
	const newWorkspace = async () => {
		const name = await askText({ title: "New workspace", label: "Name", placeholder: "e.g. Delivery team", required: true, confirmLabel: "Create" });
		if (!name) return;
		const r = await api.post("/api/workspaces", { name });
		await loadWorkspaces();
		navigate(chatHref(r.workspace.id));
	};

	const copyLink = (hash: string) => {
		const link = `${location.origin}${location.pathname}${hash}`;
		navigator.clipboard?.writeText(link).catch(() => void askText({ title: "Copy this link", label: "The clipboard is blocked in this browser", value: link, confirmLabel: "Done" }));
	};
	const archiveChat = async (id: string) => {
		if (!ws || !(await askConfirm({ title: "Archive this chat?", body: "It is removed from the sidebar for everyone in the workspace.", confirmLabel: "Archive" }))) return;
		await api.del(`/api/w/${ws.id}/chats/${id}`);
		if (route.page === "chat" && route.chat === id) navigate(chatHref(ws.id, undefined, route.module));
	};
	/** Put a module away (or bring it back): hidden from the sidebar, home and menus; its code, data and shares stay. */
	const setArchived = async (g: Module, archived: boolean) => {
		await api.patch(`/api/modules/${g.id}`, { archived });
		if (archived && ws && route.page === "chat" && route.module === g.id) navigate(chatHref(ws.id, chatId));
	};
	const deleteModule = async (g: Module) => {
		if (!ws || !(await askConfirm({ title: `Delete "${g.name}"?`, body: "Its code and data are removed for everyone it is shared with.", danger: true, confirmLabel: "Delete" }))) return;
		await api.del(`/api/modules/${g.id}`).catch((e) => reportError(e.message));
		if (route.page === "chat" && route.module === g.id) navigate(chatHref(ws.id, chatId));
	};
	const openModuleId = route.page === "chat" || route.page === "module" ? route.module : undefined;
	const relatedChats = openModuleId ? chats.filter((c) => c.moduleIds?.includes(openModuleId)) : [];
	// Module-only URLs recover their chat context; an explicit chat URL always wins.
	const chatId = route.page === "chat" ? route.chat ?? relatedChats[0]?.id : undefined;
	// Pin recovered context in the URL so another chat's later activity cannot steal selection.
	useEffect(() => {
		if (route.page === "chat" && route.module && !route.chat && chatId && ws) navigate(chatHref(ws.id, chatId, route.module, route.focus));
	}, [route, chatId, ws?.id]);
	const relatedModuleIds = chatId ? docs.chats.chats[chatId]?.moduleIds ?? [] : [];
	const relatedModules = modules.filter((m) => relatedModuleIds.includes(m.id));
	const chatForModule = (id: string) => {
		const linked = chats.filter((c) => c.moduleIds?.includes(id));
		return linked.some((c) => c.id === chatId) ? chatId : linked[0]?.id;
	};
	const rowClass = (key: string, on: boolean, related = false) => `side-row ${on ? "on" : ""} ${related ? "related" : ""} ${menuOpen === key ? "menu-open" : ""}`;

	const moduleOpen = route.page === "chat" && route.module;
	const chatHidden = route.page === "chat" && !!route.module && !!route.focus;
	const canEdit = ws?.role !== "viewer";

	return (
		<div className={`shell ${moduleOpen ? "with-module" : ""} ${chatHidden ? "chat-hidden" : ""} ${collapsed ? "side-collapsed" : ""}`}>
			<aside className="sidebar">
				<div className="brand">
					<a className="logo" href={wsId ? homeHref(wsId) : "#"} title="Workspace home" onClick={(e) => (wsId ? undefined : e.preventDefault())}>
						<img src="/outpost.svg" width="30" height="30" alt="Outpost home" />
					</a>
					<a className="name" href={wsId ? homeHref(wsId) : "#"} title="Workspace home">
						Outpost
					</a>
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
								<a className={`side-item ${route.page === "connections" ? "on" : ""}`} href={`#/w/${ws.id}/connections`}>
									<span className="ico">⇄</span>
									<span className="t">Connections</span>
									{proposed > 0 && <span className="badge" title="Connections agents proposed, waiting for an owner">{proposed}</span>}
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
							<span>Missions</span>
							{canEdit && ws && (
								<button className="side-add" onClick={() => setNewMission(true)} title="New mission: a team of agents builds it">
									+
								</button>
							)}
						</div>
						{missions.length === 0 && canEdit && (
							<a className="side-item" href="#" style={{ color: "#6c6655" }} onClick={(e) => (e.preventDefault(), setNewMission(true))}>
								Give a team of agents a goal
							</a>
						)}
						{ws &&
							missions.map((p) => (
								<a key={p.id} className={`side-item ${route.page === "mission" && route.mission === p.id ? "on" : ""}`} href={missionHref(ws.id, p.id)} title={p.goal}>
									<span className="ico">◈</span>
									<span className="t">{p.name}</span>
									<span className="ago">{p.stage}</span>
								</a>
							))}
					</div>
					<div className="side-section">
						<div className="label">
							<span>Chats</span>
							<span>{chats.length || ""}</span>
						</div>
						{chats.length === 0 && <div className="side-item muted" style={{ color: "#6c6655" }}>No chats yet</div>}
						{ws &&
							chats.map((c) => {
								const on = chatId === c.id;
								const related = !!openModuleId && !!c.moduleIds?.includes(openModuleId);
								const href = chatHref(ws.id, c.id);
								return renaming === `c:${c.id}` ? (
									<div key={c.id} className="side-item editing">
										<InlineRename value={c.title} onSave={(title) => api.patch(`/api/w/${ws.id}/chats/${c.id}`, { title })} onDone={() => setRenaming(undefined)} />
									</div>
								) : (
									<div key={c.id} data-chat-id={c.id} className={rowClass(`c:${c.id}`, on, related)}>
										<a
											className={`side-item ${on ? "on" : ""} ${related ? "related" : ""}`}
											aria-current={on ? "page" : undefined}
											href={chatHref(ws.id, c.id, related ? openModuleId : undefined)}
											title={canEdit ? `${c.title} — double-click to rename` : c.title}
											onDoubleClick={canEdit ? (e) => (e.preventDefault(), getSelection()?.removeAllRanges(), setRenaming(`c:${c.id}`)) : undefined}
										>
											<span className="t">{c.title}</span>
											{related && !on ? <span className="side-related" title="This chat has worked on the open module">Related</span> : <span className="ago" title={timeTitle(c.updatedAt)}>{timeAgo(c.updatedAt)}</span>}
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
							<span>Modules</span>
							<span>{modules.length || ""}</span>
						</div>
						{modules.length === 0 && <div className="side-item" style={{ color: "#6c6655" }}>Ask the agent to build one</div>}
						{ws &&
							modules.map((g) => {
								const on = openModuleId === g.id;
								const related = relatedModuleIds.includes(g.id);
								const canChange = g.role === "owner" || g.role === "editor";
								return renaming === `g:${g.id}` ? (
									<div key={g.id} className="side-item editing">
										<span className="ico">{g.icon}</span>
										<InlineRename value={g.name} onSave={(name) => api.patch(`/api/modules/${g.id}`, { name })} onDone={() => setRenaming(undefined)} />
									</div>
								) : (
									<div key={g.id} data-module-id={g.id} className={rowClass(`g:${g.id}`, on, related)}>
										<a
											className={`side-item ${on ? "on" : ""} ${related ? "related" : ""}`}
											aria-current={on ? "page" : undefined}
											href={chatHref(ws.id, chatForModule(g.id), g.id, true)}
											title={canChange ? `${g.name} — double-click to rename` : g.name}
											onDoubleClick={canChange ? (e) => (e.preventDefault(), getSelection()?.removeAllRanges(), setRenaming(`g:${g.id}`)) : undefined}
										>
											<span className="ico">{g.icon}</span>
											<span className="t">{g.name}</span>
											{related && !on && <span className="side-related" title="This module is used in the active chat">Related</span>}
										</a>
										<RowMenu
											label={g.name}
											onOpenChange={(o) => setMenuOpen(o ? `g:${g.id}` : undefined)}
											items={[
												{ label: "Rename", icon: "✎", onSelect: () => setRenaming(`g:${g.id}`), hidden: !canChange },
												{ label: "Open full page", icon: "⤢", onSelect: () => navigate(`#/modules/${g.id}`) },
												{
													label: "Share…",
													icon: "⇪",
													hidden: g.role !== "owner",
													onSelect: () => {
														navigate(chatHref(ws.id, chatForModule(g.id), g.id, route.page === "chat" && route.module === g.id ? route.focus : true));
														setTabRequest((t) => ({ module: g.id, tab: "share", n: (t?.n ?? 0) + 1 }));
													},
												},
												{ label: "Copy link", icon: "⧉", onSelect: () => copyLink(`#/modules/${g.id}`) },
												{ label: "Archive", icon: "▣", onSelect: () => setArchived(g, true).catch((e) => reportError(e.message)), hidden: !canChange },
												{ label: "Export", icon: "⤓", onSelect: () => exportModule(g.id, false).catch((e) => reportError(e.message)), hidden: !canChange },
												{ label: "Export with data", icon: "⤓", onSelect: () => exportModule(g.id, true).catch((e) => reportError(e.message)), hidden: !canChange },
												{ label: "Delete", icon: "✕", onSelect: () => deleteModule(g), danger: true, hidden: g.role !== "owner" },
											]}
										/>
									</div>
								);
							})}
					</div>
					{archived.length + archivedChats.length > 0 && (
						<div className="side-section">
							<button type="button" className="label side-archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
								<span>Archived</span>
								<span>
									{archived.length + archivedChats.length} {showArchived ? "▾" : "▸"}
								</span>
							</button>
							{showArchived &&
								ws &&
								archivedChats.map((c) => (
									<div key={c.id} data-chat-id={c.id} className={`side-row archived ${menuOpen === `c:${c.id}` ? "menu-open" : ""}`}>
										<a className="side-item archived" href={chatHref(ws.id, c.id)} title={`${c.title} — archived ${timeAgo(c.updatedAt)} (${timeTitle(c.updatedAt)})`}>
											<span className="ico">💬</span>
											<span className="t">{c.title}</span>
										</a>
										<RowMenu
											label={c.title}
											onOpenChange={(o) => setMenuOpen(o ? `c:${c.id}` : undefined)}
											items={[
												{ label: "Restore", icon: "▣", onSelect: () => restoreChat(c.id), hidden: !canEditChats },
												{ label: "Open", icon: "⤢", onSelect: () => navigate(chatHref(ws.id, c.id)) },
												{ label: "Copy link", icon: "⧉", onSelect: () => copyLink(`#/w/${ws.id}/c/${c.id}`) },
											]}
										/>
									</div>
								))}
							{showArchived &&
								ws &&
								archived.map((g) => {
									const canChange = g.role === "owner" || g.role === "editor";
									return (
										<div key={g.id} data-module-id={g.id} className={`side-row archived ${menuOpen === `g:${g.id}` ? "menu-open" : ""}`}>
											<a className="side-item archived" href={chatHref(ws.id, undefined, g.id, true)} title={`${g.name} — archived ${timeAgo(g.archivedAt ?? g.updatedAt)}`}>
												<span className="ico">{g.icon}</span>
												<span className="t">{g.name}</span>
											</a>
											<RowMenu
												label={g.name}
												onOpenChange={(o) => setMenuOpen(o ? `g:${g.id}` : undefined)}
												items={[
													{ label: "Restore", icon: "▣", onSelect: () => setArchived(g, false).catch((e) => reportError(e.message)), hidden: !canChange },
													{ label: "Open", icon: "⤢", onSelect: () => navigate(chatHref(ws.id, undefined, g.id, true)) },
													{ label: "Copy link", icon: "⧉", onSelect: () => copyLink(`#/modules/${g.id}`) },
													{ label: "Delete", icon: "✕", onSelect: () => deleteModule(g), danger: true, hidden: g.role !== "owner" },
												]}
											/>
										</div>
									);
								})}
						</div>
					)}
					{shared.length > 0 && (
						<div className="side-section">
							<div className="label">
								<span>Shared with me</span>
							</div>
							{shared.map((g) => (
								<a key={g.id} className={`side-item ${route.page === "module" && route.module === g.id ? "on" : ""}`} href={`#/modules/${g.id}`}>
									<span className="ico">{g.icon}</span>
									<span className="t">{g.name}</span>
									<span className="ago">{g.role}</span>
								</a>
							))}
						</div>
					)}
				</div>
				<div className="side-foot">
					<UserMenu user={user} onSignOut={onSignOut} />
					<button className="side-hide" title="Hide the side panel" aria-label="Hide the side panel" onClick={() => setSidebar(true)}>
						«
					</button>
				</div>
			</aside>
			{collapsed && (
				<button className="side-reveal" title="Show the side panel" aria-label="Show the side panel" onClick={() => setSidebar(false)}>
					»
				</button>
			)}

			{route.page === "chat" && ws && <ChatView key={`${ws.id}:${chatId ?? ""}`} ws={ws} chatId={chatId} relatedModules={relatedModules} modules={[...modules, ...archived]} files={docs.files.files} chats={docs.chats.chats} models={models} defaultModel={defaultModel} grants={docs.grants} openModule={route.module} module={modules.find((g) => g.id === route.module)} picker={picker} onManageModels={() => setManagingModels(true)} onNewChat={newChat} />}
			{route.page === "chat" && ws && route.module && (
				<ModuleWindow key={route.module} moduleId={route.module} user={user} grants={docs.grants} tabRequest={tabRequest?.module === route.module ? tabRequest : undefined}
					chatHidden={chatHidden}
					onToggleChat={() => navigate(chatHref(ws.id, chatId, route.module, !chatHidden))}
					onClose={() => navigate(chatHref(ws.id, chatId))} />
			)}
			{route.page === "blueprints" && ws && <BlueprintsPage ws={ws} />}
			{route.page === "mission" && ws && <MissionPage key={route.mission} ws={ws} missionId={route.mission} tab={route.tab} models={models} picker={picker} grants={docs.grants} />}
			{route.page === "files" && ws && <FilesPage ws={ws} files={docs.files.files} modules={modules} />}
			{updated && (
				<div className="update-banner" role="status">
					Outpost was updated while this tab was open.
					<button className="btn small primary" onClick={() => location.reload()}>
						Reload
					</button>
				</div>
			)}
			{route.page === "connections" && ws && <ConnectionsPage ws={ws} />}
			{route.page === "settings" && ws && <SettingsPage ws={ws} onChanged={() => (loadWorkspaces(), loadModels())} onManageModels={() => setManagingModels(true)} />}
			{route.page === "module" && (
				<div className="main" style={{ display: "flex" }}>
					<ModuleWindow key={route.module} moduleId={route.module} user={user} grants={docs.grants} standalone onClose={() => navigate("#/")} />
				</div>
			)}
			{route.page === "home" && ws && (
				<HomePage key={`${ws.id}:home`} ws={ws} user={user} canEdit={canEdit} onNewChat={newChat} onNewMission={() => setNewMission(true)} onApprovals={() => setDrawer(true)} />
			)}
			{(route.page === "home" && !ws) || route.page === "link" ? <div className="main" /> : null}

			{newMission && ws && <NewMissionDialog ws={ws} models={models} picker={picker} defaultModel={defaultModel} onClose={() => setNewMission(false)} />}
			{managingModels && (
				<ModelPickerDialog
					models={models}
					picker={picker}
					onClose={() => setManagingModels(false)}
					onSave={async (next) => setPicker((await api.put("/api/me/model-picker", { picker: next })).picker)}
				/>
			)}
			{drawer && ws && <ApprovalsDrawer ws={ws} docs={docs} modules={modules} onClose={() => setDrawer(false)} />}
		</div>
	);
}
