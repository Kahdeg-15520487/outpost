import { useMemo, useState } from "react";
import type { ModelInfo } from "../api";
import { Dialog } from "./bits";

/** provider id → model ids the picker shows; providers not listed show all their models. */
export type ModelPicker = Record<string, string[]>;

const keyOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

/** Whether the chat model dropdown shows this model for this user. */
export const pickerShows = (picker: ModelPicker, m: { provider: string; id: string }) => !picker[m.provider] || picker[m.provider]!.includes(m.id);

const ctx = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

/** Choose which models appear in your chat model dropdown. */
export function ModelPickerDialog({ models, picker, onSave, onClose }: { models: ModelInfo[]; picker: ModelPicker; onSave: (p: ModelPicker) => Promise<void>; onClose: () => void }) {
	const [sel, setSel] = useState(() => new Set(models.filter((m) => pickerShows(picker, m)).map(keyOf)));
	const [q, setQ] = useState("");
	const [open, setOpen] = useState<Set<string>>(() => new Set(models.length < 60 ? models.map((m) => m.provider) : []));
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState("");

	const groups = useMemo(() => {
		const g = new Map<string, ModelInfo[]>();
		for (const m of models) g.set(m.provider, [...(g.get(m.provider) ?? []), m]);
		return [...g];
	}, [models]);
	const needle = q.trim().toLowerCase();
	const matches = (m: ModelInfo) => !needle || m.name.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle) || m.provider.toLowerCase().includes(needle);

	const toggle = (keys: string[], on: boolean) =>
		setSel((s) => {
			const n = new Set(s);
			for (const k of keys) on ? n.add(k) : n.delete(k);
			return n;
		});

	const save = async () => {
		// Keep curation for providers that aren't available right now (e.g. a key is temporarily missing).
		const next: ModelPicker = { ...picker };
		for (const [provider, list] of groups) {
			const ids = list.filter((m) => sel.has(keyOf(m))).map((m) => m.id);
			if (ids.length === list.length) delete next[provider];
			else next[provider] = ids;
		}
		setSaving(true);
		setErr("");
		try {
			await onSave(next);
			onClose();
		} catch (e: any) {
			setErr(e.message);
			setSaving(false);
		}
	};

	const shown = models.filter((m) => sel.has(keyOf(m))).length;

	return (
		<Dialog onClose={onClose} className="mp-dialog">
			<h2>Models in your picker</h2>
			<p className="muted" style={{ margin: "0 0 12px", fontSize: 13.5 }}>
				Choose which models the chat dropdown offers. This is just for you. A provider left fully checked also shows models it adds later.
			</p>
			<div className="row" style={{ marginBottom: 10 }}>
				<input className="input grow" placeholder="Search models…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
				<button className="btn ghost small" onClick={() => toggle(models.filter(matches).map(keyOf), true)}>
					{needle ? "Check matches" : "Check all"}
				</button>
				<button className="btn ghost small" onClick={() => toggle(models.filter(matches).map(keyOf), false)}>
					{needle ? "Uncheck matches" : "Uncheck all"}
				</button>
			</div>
			<div className="mp-list">
				{groups.map(([provider, list]) => {
					const visible = list.filter(matches);
					if (!visible.length) return null;
					const on = list.filter((m) => sel.has(keyOf(m))).length;
					const expanded = !!needle || open.has(provider);
					return (
						<div key={provider} className="mp-group">
							<div className="mp-provider">
								<input
									type="checkbox"
									aria-label={`Show all ${provider} models`}
									checked={on === list.length}
									ref={(el) => {
										if (el) el.indeterminate = on > 0 && on < list.length;
									}}
									onChange={(e) => toggle((needle ? visible : list).map(keyOf), e.target.checked)}
								/>
								<button className="mp-expand" onClick={() =>
										setOpen((s) => {
											const n = new Set(s);
											if (!n.delete(provider)) n.add(provider);
											return n;
										})
									} aria-expanded={expanded}>
									<span className="mp-caret">{expanded ? "▾" : "▸"}</span>
									<span className="mp-pname">{provider}</span>
									<span className="mono muted">
										{on === list.length ? `all ${list.length}` : `${on} of ${list.length}`}
									</span>
								</button>
							</div>
							{expanded &&
								visible.map((m) => (
									<label key={m.id} className="mp-model">
										<input type="checkbox" checked={sel.has(keyOf(m))} onChange={(e) => toggle([keyOf(m)], e.target.checked)} />
										<span className="mp-name">{m.name}</span>
										<span className="mp-id mono">{m.id}</span>
										<span className="mp-tags mono">
											{m.reasoning && <span title="Reasoning">think</span>}
											{m.vision && <span title="Accepts images">img</span>}
											{m.contextWindow > 0 && <span title="Context window">{ctx(m.contextWindow)}</span>}
										</span>
									</label>
								))}
						</div>
					);
				})}
				{!models.some(matches) && <div className="muted" style={{ padding: 12 }}>No models match “{q}”.</div>}
			</div>
			<div className="row" style={{ marginTop: 14 }}>
				<span className="muted grow" style={{ fontSize: 13 }}>
					{shown} of {models.length} models shown
				</span>
				{err && <span className="err">{err}</span>}
				<button className="btn ghost" onClick={onClose}>
					Cancel
				</button>
				<button className="btn primary" disabled={saving || shown === 0} title={shown === 0 ? "Pick at least one model" : undefined} onClick={save}>
					{saving ? "Saving…" : "Save"}
				</button>
			</div>
		</Dialog>
	);
}
