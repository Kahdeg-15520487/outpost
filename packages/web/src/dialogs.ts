/**
 * In-app dialogs instead of the browser's `confirm`/`prompt`/`alert`: they look like Outpost, they
 * can be dismissed with Escape, and a test can click them. One dialog at a time — a new request
 * cancels whatever was open, so nothing can stack up behind a modal.
 */

import { toast } from "./toasts";

export type ConfirmRequest = {
	kind: "confirm";
	id: number;
	title: string;
	body?: string;
	confirmLabel: string;
	cancelLabel: string;
	danger?: boolean;
	resolve: (ok: boolean) => void;
};

export type TextRequest = {
	kind: "text";
	id: number;
	title: string;
	label?: string;
	value: string;
	placeholder?: string;
	confirmLabel: string;
	cancelLabel: string;
	required?: boolean;
	multiline?: boolean;
	resolve: (value: string | undefined) => void;
};

export type Request = ConfirmRequest | TextRequest;

export type ConfirmOptions = {
	title: string;
	body?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Red confirm button, for anything that deletes or archives. */
	danger?: boolean;
};

export type TextOptions = {
	title: string;
	label?: string;
	value?: string;
	placeholder?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	required?: boolean;
	multiline?: boolean;
};

let current: Request | undefined;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function open<T extends Request>(request: T): Promise<unknown> {
	// A modal that is already up loses: its caller gets a cancelled answer rather than a stale action.
	if (current) settle(current.kind === "confirm" ? false : undefined);
	current = request;
	emit();
	return new Promise((resolve) => {
		(request as T & { resolve: (v: unknown) => void }).resolve = resolve;
	});
}

/** Ask a yes/no question. Accepts a bare string for the common "do this?" case. */
export function askConfirm(options: ConfirmOptions | string): Promise<boolean> {
	const opts: ConfirmOptions = typeof options === "string" ? { title: options } : options;
	return open({
		kind: "confirm",
		id: ++seq,
		title: opts.title,
		...(opts.body ? { body: opts.body } : {}),
		confirmLabel: opts.confirmLabel ?? "Continue",
		cancelLabel: opts.cancelLabel ?? "Cancel",
		...(opts.danger ? { danger: true } : {}),
		resolve: () => undefined,
	}) as Promise<boolean>;
}

/** Ask for a line of text (or several). Resolves `undefined` when cancelled. */
export function askText(options: TextOptions | string): Promise<string | undefined> {
	const opts: TextOptions = typeof options === "string" ? { title: options } : options;
	return open({
		kind: "text",
		id: ++seq,
		title: opts.title,
		...(opts.label ? { label: opts.label } : {}),
		value: opts.value ?? "",
		...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
		confirmLabel: opts.confirmLabel ?? "Save",
		cancelLabel: opts.cancelLabel ?? "Cancel",
		...(opts.required ? { required: true } : {}),
		...(opts.multiline ? { multiline: true } : {}),
		resolve: () => undefined,
	}) as Promise<string | undefined>;
}

/** Close the open dialog and hand the answer to whoever asked. */
export function settle(value: boolean | string | undefined) {
	const request = current;
	if (!request) return;
	current = undefined;
	emit();
	if (request.kind === "confirm") (request as ConfirmRequest).resolve(value === true);
	else (request as TextRequest).resolve(typeof value === "string" ? value : undefined);
}

/** What used to be `alert(e.message)`: the same message, as a toast that fits the app. */
export function reportError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error ?? "");
	toast({ text: message || "Something went wrong" });
}

export const dialogs = {
	subscribe(listener: () => void) {
		listeners.add(listener);
		return () => void listeners.delete(listener);
	},
	get: () => current,
};
