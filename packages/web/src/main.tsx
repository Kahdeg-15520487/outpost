import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./artifacts.css";
import "./blueprints.css";
import { api, type User } from "./api";
import { socket } from "./socket";
import { navigate, useRoute } from "./store";
import { Login } from "./components/Login";
import { Shell } from "./components/Shell";
import { ConnectionUI } from "./components/ConnectionUI";
import { DialogHost } from "./components/DialogHost";
import { reportError } from "./dialogs";
// Last: this sheet overrides the component sheets, so it has to be emitted after them.
import "./responsive.css";

function App() {
	const [user, setUser] = useState<User | null | undefined>(undefined);
	const route = useRoute();

	useEffect(() => {
		api.get("/api/me").then((r) => setUser(r.user)).catch(() => setUser(null));
	}, []);
	useEffect(() => {
		if (user) socket.connect();
	}, [user]);

	// Share links: accept, then open the module.
	useEffect(() => {
		if (user && route.page === "link") {
			api.post(`/api/links/${route.token}/accept`).then((r) => navigate(`#/modules/${r.moduleId}`)).catch(reportError);
		}
	}, [user, route]);

	if (user === undefined)
		return (
			<>
				<ConnectionUI />
			<DialogHost />
			</>
		);
	if (!user)
		return (
			<>
				<ConnectionUI />
			<DialogHost />
				<Login onAuthed={setUser} />
			</>
		);
	return (
		<>
			<ConnectionUI />
			<DialogHost />
			<Shell
			user={user}
				onSignOut={async () => {
					await api.post("/api/auth/logout");
					socket.close();
					setUser(null);
					location.hash = "";
				}}
			/>
		</>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
