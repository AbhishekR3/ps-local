// Battle-state parser: consumes the raw Pokemon Showdown protocol stream (exactly the
// frames the client's WebSocket receives) and maintains a structured snapshot of the
// current battle — format, active field, revealed Pokemon, and (for your own side) full
// team detail from the |request| message.
//
// Protocol reference: sim/SIM-PROTOCOL.md and PROTOCOL.md in the repo root.
import { toID } from './toid.js';

// "Swampert, L82, M, shiny, tera:Fire" -> {species, level, gender, shiny, tera}
export function parseDetails(details) {
	const parts = details.split(',').map((p) => p.trim());
	const out = { species: parts[0], level: 100, gender: '', shiny: false, tera: null };
	for (let i = 1; i < parts.length; i++) {
		const p = parts[i];
		if (/^L\d+$/.test(p)) out.level = parseInt(p.slice(1), 10);
		else if (p === 'M' || p === 'F') out.gender = p;
		else if (p === 'shiny') out.shiny = true;
		else if (p.startsWith('tera:')) out.tera = p.slice(5);
	}
	return out;
}

// "p1a: Nickname" -> {side:'p1', pos:'a', slot:'p1a', name:'Nickname'}
// Team-preview / request idents are "p1: Nickname" (no position).
export function parseIdent(ident) {
	const m = ident.match(/^(p[1-4])([a-c]?): (.*)$/);
	if (!m) return null;
	return { side: m[1], pos: m[2], slot: m[1] + (m[2] || ''), name: m[3] };
}

// "82/100 brn" | "0 fnt" | "100/100" -> {hp, maxhp, status, fainted}
export function parseCondition(cond) {
	const [hpPart, status] = cond.split(' ');
	if (hpPart === '0' || status === 'fnt') return { hp: 0, maxhp: 100, status: 'fnt', fainted: true };
	const [hp, maxhp] = hpPart.split('/').map(Number);
	return { hp, maxhp: maxhp || 100, status: status || '', fainted: false };
}

function emptyState() {
	return {
		roomid: null,
		formatId: null,
		gen: null,
		gameType: null,
		tier: null,
		mySide: null,
		players: {},
		active: {},        // slot -> active Pokemon
		revealed: { p1: {}, p2: {}, p3: {}, p4: {} }, // side -> speciesId -> reveal info
		myTeam: [],        // full detail from |request| (your side only)
		turn: 0,
		ended: false,      // |win| / |tie| — battle decided, board still meaningful
		closed: false,     // |deinit| — room torn down (user left/closed), board is stale
		// Additional state for battle-log export
		weather: null,           // 'RainDance' | 'Sandstorm' | 'SunnyDay' | 'Hail' | 'Snow' | null
		terrain: null,           // 'Electric' | 'Grassy' | 'Misty' | 'Psychic' | null
		sideConditions: { p1: {}, p2: {}, p3: {}, p4: {} }, // side -> condition -> layer count
		pseudoWeather: {},       // condition -> 1 (e.g. TrickRoom, WonderRoom)
		boosts: {},              // slot -> { atk, def, spa, spd, spe, acc, eva } — reset on switch
		volatiles: {},           // slot -> { condition: true, … } — reset on switch
		winner: null,            // player name from |win|, null on tie
		turnLog: [],             // [{ num, lines: [] }] — raw protocol lines grouped per turn
		_currentTurnLines: null, // internal accumulator for current turn (not serialised)
	};
}

export class BattleTracker {
	constructor() {
		this.state = emptyState();
	}

	reset() {
		this.state = emptyState();
	}

	// Record that a side owns/revealed a species, merging in any ability/item we learn.
	_reveal(side, species, extra = {}) {
		const id = toID(species);
		if (!id) return null;
		const bucket = this.state.revealed[side] || (this.state.revealed[side] = {});
		const rec = bucket[id] || (bucket[id] = { species, ability: null, item: null, moves: new Set(), fainted: false, level: null });
		if (extra.ability) rec.ability = extra.ability;
		if (extra.item !== undefined) rec.item = extra.item;
		if (extra.level) rec.level = extra.level;
		return rec;
	}

	_slotOf(ident) {
		const p = parseIdent(ident);
		return p ? p.slot : null;
	}

	// Feed one raw WebSocket frame (may contain a leading ">roomid" line + many |...| lines).
	feed(frame) {
		const lines = frame.split('\n');
		for (const line of lines) {
			if (line.startsWith('>')) {
				this._handleRoom(line.slice(1).trim());
				continue;
			}
			if (!line.startsWith('|')) continue;
			this._handleLine(line);
		}
		return this.state;
	}

	_handleRoom(roomid) {
		// A new battle room means a fresh battle — reset, then capture the format id.
		const m = roomid.match(/^battle-([a-z0-9]+)-\d+/);
		if (m) {
			if (this.state.roomid !== roomid) {
				this.reset();
				this.state.roomid = roomid;
				this.state.formatId = m[1];
			}
		}
	}

	// "[from] item: Leftovers" (+ optional "[of] p2a: X") -> record the confirmed item on its
	// owner. Items leak through these tags on -heal/-damage/-status/-activate/etc. (Leftovers,
	// Life Orb, Rocky Helmet, Flame Orb …), which is how most items actually get confirmed.
	_learnItemFromTags(parts) {
		let item = null;
		let ofStr = null;
		for (const p of parts) {
			if (p.startsWith('[from] item:')) item = p.slice('[from] item:'.length).trim();
			else if (p.startsWith('[of] ')) ofStr = p.slice('[of] '.length).trim();
		}
		if (!item) return;
		// Owner is the [of] target when present (e.g. Rocky Helmet damaging the attacker),
		// otherwise the message's own ident (e.g. Leftovers healing its holder).
		const owner = parseIdent(ofStr || parts[2]);
		if (!owner) return;
		const species = this.state.active[owner.slot]?.species || owner.name;
		if (this.state.active[owner.slot]) this.state.active[owner.slot].item = item;
		this._reveal(owner.side, species, { item });
	}

	_handleLine(line) {
		const parts = line.split('|'); // parts[0] === '' (text before first |)
		const cmd = parts[1];
		const s = this.state;
		// Accumulate raw lines into the current turn's log entry.
		if (s._currentTurnLines) s._currentTurnLines.push(line);
		// Capture items revealed indirectly via "[from] item: X" tags, regardless of message type.
		if (line.includes('[from] item:')) this._learnItemFromTags(parts);
		switch (cmd) {
			case 'gen':
				s.gen = parseInt(parts[2], 10);
				break;
			case 'gametype':
				s.gameType = parts[2];
				break;
			case 'tier':
				s.tier = parts[2];
				break;
			case 'player': {
				const side = parts[2];
				if (side && parts[3]) s.players[side] = { name: parts[3] };
				break;
			}
			case 'poke': {
				// |poke|SIDE|DETAILS|item  — team preview reveal (species only)
				const side = parts[2];
				const det = parseDetails(parts[3] || '');
				this._reveal(side, det.species);
				break;
			}
			case 'switch':
			case 'drag':
			case 'replace': {
				this._onSwitch(parts);
				break;
			}
			case 'move': {
				// |move|p2a: Swampert|Earthquake|p1a: Pikachu — record the move under the user's species.
				const p = parseIdent(parts[2]);
				if (p && parts[3]) {
					const species = s.active[p.slot]?.species || p.name;
					const rec = this._reveal(p.side, species);
					if (rec) rec.moves.add(toID(parts[3]));
				}
				break;
			}
			case 'detailschange':
			case '-formechange': {
				// Forme/mega change: update the active slot's species in place.
				const slot = this._slotOf(parts[2]);
				if (slot && s.active[slot]) {
					const det = parseDetails(parts[3] || '');
					s.active[slot].species = det.species;
					if (det.tera) s.active[slot].tera = det.tera;
					this._reveal(s.active[slot].side, det.species);
				}
				break;
			}
			case '-damage':
			case '-heal':
			case '-sethp': {
				const slot = this._slotOf(parts[2]);
				if (slot && s.active[slot] && parts[3]) {
					Object.assign(s.active[slot], parseCondition(parts[3]));
				}
				break;
			}
			case '-status': {
				const slot = this._slotOf(parts[2]);
				if (slot && s.active[slot]) s.active[slot].status = parts[3];
				break;
			}
			case 'faint': {
				const slot = this._slotOf(parts[2]);
				if (slot && s.active[slot]) {
					s.active[slot].fainted = true;
					s.active[slot].hp = 0;
					// Mark the revealed-record fainted too so the bench can sort dead mons last.
					const rec = this._reveal(s.active[slot].side, s.active[slot].species);
					if (rec) rec.fainted = true;
				}
				break;
			}
			case '-terastallize': {
				const slot = this._slotOf(parts[2]);
				if (slot && s.active[slot]) s.active[slot].tera = parts[3];
				break;
			}
			case '-ability': {
				const p = parseIdent(parts[2]);
				if (p) {
					if (s.active[p.slot]) s.active[p.slot].ability = parts[3];
					this._reveal(p.side, s.active[p.slot]?.species || p.name, { ability: parts[3] });
				}
				break;
			}
			case '-item': {
				const p = parseIdent(parts[2]);
				if (p) {
					if (s.active[p.slot]) s.active[p.slot].item = parts[3];
					this._reveal(p.side, s.active[p.slot]?.species || p.name, { item: parts[3] });
				}
				break;
			}
			case '-enditem': {
				// The item is gone but now confirmed (Berry eaten, Knocked Off, etc.). Record it
				// as the known item; the owner is this ident — NOT any [of] knocker.
				const p = parseIdent(parts[2]);
				if (p) {
					this._reveal(p.side, s.active[p.slot]?.species || p.name, { item: parts[3] });
					if (s.active[p.slot]) s.active[p.slot].item = null;
				}
				break;
			}
			case 'turn': {
				const num = parseInt(parts[2], 10);
				// Flush the previous turn's lines into turnLog before starting the new one.
				if (s._currentTurnLines) s.turnLog.push({ num: s.turn, lines: s._currentTurnLines });
				s.turn = num;
				s._currentTurnLines = [];
				break;
			}
			case 'request':
				this._onRequest(parts.slice(2).join('|'));
				break;
			case 'win':
				s.winner = parts[2] || null;
				s.ended = true;
				this._flushTurnLog();
				break;
			case 'tie':
				s.ended = true;
				this._flushTurnLog();
				break;
			case 'deinit':
				// Room torn down (user closed/left the battle). Board is no longer live.
				s.closed = true;
				break;
			case '-boost':
			case '-unboost': {
				const slot = this._slotOf(parts[2]);
				if (slot) {
					const b = s.boosts[slot] || (s.boosts[slot] = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 });
					const delta = parseInt(parts[4], 10) || 1;
					const stat = parts[3];
					if (stat in b) b[stat] += cmd === '-boost' ? delta : -delta;
				}
				break;
			}
			case '-setboost': {
				const slot = this._slotOf(parts[2]);
				if (slot) {
					const b = s.boosts[slot] || (s.boosts[slot] = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 });
					const stat = parts[3];
					if (stat in b) b[stat] = parseInt(parts[4], 10) || 0;
				}
				break;
			}
			case '-clearboost': {
				// Clear Smog, Topsy-Turvy, etc. — zero one slot's boosts.
				const slot = this._slotOf(parts[2]);
				if (slot) s.boosts[slot] = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
				break;
			}
			case '-clearallboost':
				// Haze — reset everyone.
				s.boosts = {};
				break;
			case '-invertboost': {
				const slot = this._slotOf(parts[2]);
				if (slot && s.boosts[slot]) {
					for (const k of Object.keys(s.boosts[slot])) s.boosts[slot][k] = -s.boosts[slot][k];
				}
				break;
			}
			case '-weather': {
				const w = parts[2];
				s.weather = (w === 'none' || !w) ? null : w;
				break;
			}
			case '-terrain': {
				const t = parts[2];
				s.terrain = (t === 'none' || !t) ? null : t;
				break;
			}
			case '-fieldstart': {
				const effect = parts[2]?.replace(/^move: /, '');
				if (effect) s.pseudoWeather[effect] = 1;
				break;
			}
			case '-fieldend': {
				const effect = parts[2]?.replace(/^move: /, '');
				if (effect) delete s.pseudoWeather[effect];
				break;
			}
			case '-sidestart': {
				// |-sidestart|p1|move: Reflect  or  |-sidestart|p1|Spikes
				const side = parts[2]?.replace(/:.*/, ''); // 'p1' from 'p1: SideName'
				const cond = parts[3]?.replace(/^move: /, '');
				if (side && cond) {
					const sc = s.sideConditions[side] || (s.sideConditions[side] = {});
					sc[cond] = (sc[cond] || 0) + 1;
				}
				break;
			}
			case '-sideend': {
				const side = parts[2]?.replace(/:.*/, '');
				const cond = parts[3]?.replace(/^move: /, '');
				if (side && cond && s.sideConditions[side]) delete s.sideConditions[side][cond];
				break;
			}
			case '-start': {
				// |-start|IDENT|EFFECT  — volatile status on a specific Pokemon.
				const slot = this._slotOf(parts[2]);
				const effect = parts[3]?.replace(/^move: /, '');
				if (slot && effect) {
					const v = s.volatiles[slot] || (s.volatiles[slot] = {});
					v[effect] = true;
				}
				break;
			}
			case '-end': {
				const slot = this._slotOf(parts[2]);
				const effect = parts[3]?.replace(/^move: /, '');
				if (slot && effect && s.volatiles[slot]) delete s.volatiles[slot][effect];
				break;
			}
		}
	}

	_flushTurnLog() {
		const s = this.state;
		if (s._currentTurnLines && s._currentTurnLines.length) {
			s.turnLog.push({ num: s.turn, lines: s._currentTurnLines });
			s._currentTurnLines = null;
		}
	}

	_onSwitch(parts) {
		// |switch|p1a: Nick|DETAILS|CONDITION
		const ident = parseIdent(parts[2]);
		if (!ident) return;
		const det = parseDetails(parts[3] || '');
		const cond = parts[4] ? parseCondition(parts[4]) : { hp: 100, maxhp: 100, status: '', fainted: false };
		this.state.active[ident.slot] = {
			side: ident.side,
			pos: ident.pos,
			slot: ident.slot,
			name: ident.name,
			species: det.species,
			level: det.level,
			gender: det.gender,
			shiny: det.shiny,
			tera: det.tera,
			ability: null,
			item: undefined,
			...cond,
		};
		// Boosts and volatiles don't carry over to the switch-in.
		delete this.state.boosts[ident.slot];
		delete this.state.volatiles[ident.slot];
		this._reveal(ident.side, det.species, { level: det.level });
	}

	_onRequest(json) {
		if (!json) return;
		let req;
		try {
			req = JSON.parse(json);
		} catch {
			return;
		}
		if (req.side && Array.isArray(req.side.pokemon)) {
			this.state.mySide = req.side.id;
			this.state.myTeam = req.side.pokemon.map((p) => {
				const det = parseDetails(p.details || '');
				return {
					species: det.species,
					level: det.level,
					gender: det.gender,
					condition: p.condition,
					active: !!p.active,
					stats: p.stats,
					moves: p.moves,
					ability: p.ability || p.baseAbility,
					item: p.item,
					teraType: p.teraType,
				};
			});
		}
	}
}
