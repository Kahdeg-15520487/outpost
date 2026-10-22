// Shared task list — every mutation is atomic and broadcast to everyone viewing.
export default class TodoServer {
  static readonly = ["list"];

  constructor(ctx) { this.ctx = ctx; }

  _items() { return this.ctx.storage.get("items") ?? []; }
  _save(items) {
    this.ctx.storage.set("items", items);
    this.ctx.broadcast("changed", items);
    return items;
  }

  list() { return this._items(); }

  add(text, assignee = null) {
    if (text && typeof text === "object") ({ text, assignee = null } = text);
    text = String(text ?? "").trim();
    if (!text) throw new Error("Task text is required");
    const items = this._items();
    items.push({ id: this.ctx.id(), text: text.slice(0, 500), done: false, assignee, by: this.ctx.caller.name, at: Date.now() });
    return this._save(items);
  }

  toggle(id) {
    const items = this._items();
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error("No such task");
    item.done = !item.done;
    item.doneBy = item.done ? this.ctx.caller.name : null;
    return this._save(items);
  }

  update(id, patch) {
    const items = this._items();
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error("No such task");
    if (typeof patch.text === "string") item.text = patch.text.slice(0, 500);
    if ("assignee" in patch) item.assignee = patch.assignee || null;
    return this._save(items);
  }

  remove(id) { return this._save(this._items().filter((i) => i.id !== id)); }

  move(id, toIndex) {
    const items = this._items();
    const from = items.findIndex((i) => i.id === id);
    if (from < 0) throw new Error("No such task");
    const [item] = items.splice(from, 1);
    items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, item);
    return this._save(items);
  }

  clearDone() { return this._save(this._items().filter((i) => !i.done)); }
}
