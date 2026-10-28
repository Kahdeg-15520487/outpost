import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./artifacts.css";
import { api, type User } from "./api";
import { socket } from "./socket";
import { navigate, useRoute } from "./store";
import { Login } from "./components/Login";
import { Shell } from "./components/Shell";
import { ConnectionUI } from "./components/ConnectionUI";

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
			api.post(`/api/links/${route.token}/accept`).then((r) => navigate(`#/modules/${r.moduleId}`)).catch((e) => alert(e.message));
		}
	}, [user, route]);

	if (user === undefined)
		return (
			<>
				<ConnectionUI />
			</>
		);
	if (!user)
		return (
			<>
				<ConnectionUI />
				<Login onAuthed={setUser} />
			</>
		);
	return (
		<>
			<ConnectionUI />
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
