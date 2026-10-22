// Notes — one storage key per page; saving bumps a version so stale writes are detected.
export default class Notes {
  static readonly = ["pages", "page"];

  constructor(ctx) { this.ctx = ctx; }

  _summary(p) { return { id: p.id, title: p.title, updatedAt: p.updatedAt, updatedBy: p.updatedBy }; }

  pages() {
    return Object.values(this.ctx.storage.list("p:")).map((p) => this._summary(p)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  page(id) {
    const p = this.ctx.storage.get(`p:${id}`);
    if (!p) throw new Error("No such page");
    return p;
  }

  create(title = "Untitled", body = "") {
    if (title && typeof title === "object") ({ title = "Untitled", body = "" } = title);
    const p = { id: this.ctx.id().slice(0, 10), title: String(title).slice(0, 200), body: String(body), version: 1, updatedAt: Date.now(), updatedBy: this.ctx.caller.name };
    this.ctx.storage.set(`p:${p.id}`, p);
    this.ctx.broadcast("page", p);
    return p;
  }

  /** Save title/body. Pass the version you edited; a newer server version wins and is returned. */
  save(id, patch, baseVersion) {
    const p = this.page(id);
    if (baseVersion !== undefined && baseVersion < p.version && p.updatedBy !== this.ctx.caller.name) {
      return { conflict: true, page: p };
    }
    if (typeof patch.title === "string") p.title = patch.title.slice(0, 200);
    if (typeof patch.body === "string") p.body = patch.body;
    p.version++;
    p.updatedAt = Date.now();
    p.updatedBy = this.ctx.caller.name;
    this.ctx.storage.set(`p:${id}`, p);
    this.ctx.broadcast("page", p);
    return { conflict: false, page: p };
  }

  /** Append text to a page — handy for agents. */
  append(id, text) {
    const p = this.page(id);
    return this.save(id, { body: (p.body ? p.body + "\n\n" : "") + String(text) }).page;
  }

  remove(id) {
    this.ctx.storage.delete(`p:${id}`);
    this.ctx.broadcast("removed", id);
    return true;
  }
}
