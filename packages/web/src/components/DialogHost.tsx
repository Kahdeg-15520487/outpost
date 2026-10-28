/**
 * Renders whatever `askConfirm` / `askText` is waiting on. Mounted once, next to the toasts.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "./bits";
import { dialogs, settle } from "../dialogs";

export function DialogHost() {
	const request = useSyncExternalStore(dialogs.subscribe, dialogs.get);
	if (!request) return null;
	// keyed so the value and the autofocus start fresh for each question
	return <AskDialog key={request.id} request={request} />;
}

function AskDialog({ request }: { request: NonNullable<ReturnType<typeof dialogs.get>> }) {
	const [value, setValue] = useState(request.kind === "text" ? request.value : "");
	const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

	useEffect(() => {
		const el = input.current;
		if (!el) return;
		el.focus();
		if (el instanceof HTMLInputElement) el.select();
	}, []);

	const cancel = () => settle(request.kind === "confirm" ? false : undefined);
	const submit = () => {
		if (request.kind === "confirm") return settle(true);
		const text = value.trim();
		if (request.required && !text) return;
		settle(text);
	};

	return (
		<Dialog onClose={cancel} className="ask-dialog">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<h2 className="ask-title">{request.title}</h2>
				{request.kind === "confirm" && request.body && <p className="ask-body muted">{request.body}</p>}
				{request.kind === "text" && (
					<>
						{request.label && <div className="label ask-label">{request.label}</div>}
						{request.multiline ? (
							<textarea ref={input as any} className="input ask-input" rows={4} value={value} placeholder={request.placeholder} onChange={(e) => setValue(e.target.value)} />
						) : (
							<input ref={input as any} className="input ask-input" value={value} placeholder={request.placeholder} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
						)}
					</>
				)}
				<div className="ask-actions">
					<button type="button" className="btn ghost" onClick={cancel}>
						{request.cancelLabel}
					</button>
					<button type="submit" className={`btn ${request.kind === "confirm" && request.danger ? "danger" : "primary"}`} disabled={request.kind === "text" && request.required && !value.trim()}>
						{request.confirmLabel}
					</button>
				</div>
			</form>
		</Dialog>
	);
}
