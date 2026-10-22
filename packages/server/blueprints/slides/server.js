// Slides — the deck is one JSON document. The agent drafts and edits it through this API
// (setDeck / addSlide / updateSlide ...), people edit inline, and presenter position is shared.
const LAYOUTS = ["title", "section", "bullets", "two-column", "quote", "big-number"];
const THEMES = ["paper", "midnight", "sunset", "forest"];

const sample = () => ({
  title: "Untitled deck",
  theme: "paper",
  slides: [
    { id: "s1", layout: "title", title: "Untitled deck", subtitle: "Ask the agent to draft this deck for you" },
    { id: "s2", layout: "bullets", title: "What this deck can do", bullets: ["Six layouts: title, section, bullets, two-column, quote, big-number", "Click any text to edit it — everyone sees changes live", "Press Present: viewers follow the presenter's slide", "Speaker notes per slide"] },
    { id: "s3", layout: "big-number", title: "Edits are durable", number: "100%", caption: "Every change is committed before anyone sees it" },
  ],
  current: 0,
  presenter: null,
});

export default class Slides {
  static readonly = ["get", "layouts"];

  constructor(ctx) { this.ctx = ctx; }

  _deck() { return this.ctx.storage.get("deck") ?? sample(); }
  _save(deck) {
    deck.current = Math.max(0, Math.min(deck.slides.length - 1, deck.current ?? 0));
    this.ctx.storage.set("deck", deck);
    this.ctx.broadcast("deck", deck);
    return deck;
  }
  _clean(slide) {
    const s = { ...slide, id: slide.id || this.ctx.id().slice(0, 8) };
    if (!LAYOUTS.includes(s.layout)) s.layout = "bullets";
    if (s.bullets && !Array.isArray(s.bullets)) s.bullets = String(s.bullets).split("\n");
    return s;
  }

  get() { return this._deck(); }

  /** Layouts and the fields each one uses — for agents and editors. */
  layouts() {
    return {
      layouts: {
        title: ["title", "subtitle"],
        section: ["title", "subtitle"],
        bullets: ["title", "bullets[]"],
        "two-column": ["title", "left[]", "right[]", "leftTitle", "rightTitle"],
        quote: ["quote", "attribution"],
        "big-number": ["title", "number", "caption"],
      },
      common: ["notes"],
      themes: THEMES,
    };
  }

  /** Replace the whole deck: { title, theme?, slides: [{ layout, ...fields }] }. */
  setDeck(deck) {
    if (!deck || !Array.isArray(deck.slides) || !deck.slides.length) throw new Error("deck.slides must be a non-empty array");
    const current = this._deck();
    return this._save({ ...current, title: deck.title ?? current.title, theme: THEMES.includes(deck.theme) ? deck.theme : current.theme, slides: deck.slides.map((s) => this._clean(s)), current: 0 });
  }

  addSlide(slide, index) {
    const deck = this._deck();
    const s = this._clean(slide ?? { layout: "bullets", title: "New slide", bullets: ["Point"] });
    deck.slides.splice(index ?? deck.slides.length, 0, s);
    return this._save(deck);
  }

  updateSlide(id, patch) {
    const deck = this._deck();
    const i = deck.slides.findIndex((s) => s.id === id);
    if (i < 0) throw new Error(`No slide ${id}`);
    deck.slides[i] = this._clean({ ...deck.slides[i], ...patch, id });
    return this._save(deck);
  }

  removeSlide(id) {
    const deck = this._deck();
    if (deck.slides.length === 1) throw new Error("A deck needs at least one slide");
    deck.slides = deck.slides.filter((s) => s.id !== id);
    return this._save(deck);
  }

  moveSlide(id, toIndex) {
    const deck = this._deck();
    const from = deck.slides.findIndex((s) => s.id === id);
    if (from < 0) throw new Error(`No slide ${id}`);
    const [s] = deck.slides.splice(from, 1);
    deck.slides.splice(Math.max(0, Math.min(deck.slides.length, toIndex)), 0, s);
    return this._save(deck);
  }

  setTitle(title) { const d = this._deck(); d.title = String(title).slice(0, 200); return this._save(d); }
  setTheme(theme) {
    if (!THEMES.includes(theme)) throw new Error(`Theme must be one of ${THEMES.join(", ")}`);
    const d = this._deck(); d.theme = theme; return this._save(d);
  }

  /** Presenter controls: whoever presents drives `current` for everyone following. */
  present(on) {
    const d = this._deck();
    d.presenter = on ? this.ctx.caller.name : null;
    return this._save(d);
  }
  go(index) {
    const d = this._deck();
    d.current = index;
    return this._save(d);
  }
}
