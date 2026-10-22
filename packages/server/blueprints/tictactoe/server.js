// Tic tac toe — seats are claimed by people or by the agent (ctx.caller.kind === "agent").
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const fresh = (players = { X: null, O: null }, score = { X: 0, O: 0, draw: 0 }) => ({ board: Array(9).fill(null), turn: "X", players, winner: null, line: null, score, moves: 0 });

export default class TicTacToe {
  static readonly = ["state"];

  constructor(ctx) { this.ctx = ctx; }

  _state() { return this.ctx.storage.get("game") ?? fresh(); }
  _save(s) { this.ctx.storage.set("game", s); this.ctx.broadcast("state", s); return s; }
  _me() { const c = this.ctx.caller; return { id: c.id, name: c.kind === "agent" ? "🤖 Agent" : c.name, agent: c.kind === "agent" }; }

  state() { return this._state(); }

  /** Take seat "X" or "O" (X moves first). */
  join(side) {
    if (side !== "X" && side !== "O") throw new Error('side must be "X" or "O"');
    const s = this._state();
    const me = this._me();
    if (s.players[side] && s.players[side].id !== me.id) throw new Error(`${s.players[side].name} already has ${side}`);
    for (const k of ["X", "O"]) if (s.players[k]?.id === me.id) s.players[k] = null;
    s.players[side] = me;
    return this._save(s);
  }

  leave() {
    const s = this._state();
    for (const k of ["X", "O"]) if (s.players[k]?.id === this.ctx.caller.id) s.players[k] = null;
    return this._save(s);
  }

  /** Play cell 0-8 (row-major: 0 1 2 / 3 4 5 / 6 7 8). */
  move(cell) {
    const s = this._state();
    if (s.winner) throw new Error("Game over — call reset()");
    const seat = s.players[s.turn];
    if (!seat) throw new Error(`Nobody is playing ${s.turn} yet — join("${s.turn}") first`);
    if (seat.id !== this.ctx.caller.id) throw new Error(`It's ${seat.name}'s turn (${s.turn})`);
    if (!(cell >= 0 && cell <= 8) || s.board[cell]) throw new Error("Pick an empty cell 0-8");
    s.board[cell] = s.turn;
    s.moves++;
    const line = LINES.find(([a, b, c]) => s.board[a] && s.board[a] === s.board[b] && s.board[a] === s.board[c]);
    if (line) { s.winner = s.turn; s.line = line; s.score[s.turn]++; }
    else if (s.moves === 9) { s.winner = "draw"; s.score.draw++; }
    else s.turn = s.turn === "X" ? "O" : "X";
    return this._save(s);
  }

  reset() {
    const s = this._state();
    // Losers go first next time; swap seats so X alternates.
    return this._save(fresh({ X: s.players.O, O: s.players.X }, s.score));
  }
}
