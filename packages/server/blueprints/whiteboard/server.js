// Whiteboard — strokes are stored one key each so concurrent drawing never conflicts.
// Cursor moves are broadcast without touching storage (ephemeral presence).
export default class Whiteboard {
  static readonly = ["strokes"];

  constructor(ctx) { this.ctx = ctx; }

  strokes() {
    return Object.values(this.ctx.storage.list("s:")).sort((a, b) => a.at - b.at);
  }

  addStroke(stroke) {
    const pts = Array.isArray(stroke?.points) ? stroke.points.slice(0, 4000) : [];
    if (pts.length < 2) throw new Error("A stroke needs at least one point (x, y)");
    const s = {
      id: this.ctx.id().slice(0, 12),
      points: pts.map((n) => Math.round(Number(n) * 10) / 10),
      color: /^#[0-9a-f]{3,8}$/i.test(stroke.color) ? stroke.color : "#1d1b16",
      width: Math.max(1, Math.min(40, Number(stroke.width) || 3)),
      by: this.ctx.caller.id,
      name: this.ctx.caller.name,
      at: Date.now(),
    };
    this.ctx.storage.set(`s:${s.id}`, s);
    this.ctx.broadcast("stroke", s);
    return s.id;
  }

  /** Remove the caller's most recent stroke. */
  undo() {
    const mine = this.strokes().filter((s) => s.by === this.ctx.caller.id);
    const last = mine[mine.length - 1];
    if (!last) return null;
    this.ctx.storage.delete(`s:${last.id}`);
    this.ctx.broadcast("remove", last.id);
    return last.id;
  }

  clear() {
    for (const key of Object.keys(this.ctx.storage.list("s:"))) this.ctx.storage.delete(key);
    this.ctx.broadcast("clear", { by: this.ctx.caller.name });
    return true;
  }

  cursor(x, y) {
    this.ctx.broadcast("cursor", { id: this.ctx.caller.id, name: this.ctx.caller.name, x, y });
  }
}
