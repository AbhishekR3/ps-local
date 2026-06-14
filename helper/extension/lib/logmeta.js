// Pure, dependency-free helpers for the battle-log writer (C5). Extracted from the Electron main
// process (showdown-ui/electron/main/index.ts) so the roomid parse, filename scheme, and end-detection
// predicate can be unit-tested with `node --test` — no Electron runtime required. Like parser.js/render.js
// this must stay free of chrome/Node-only APIs so it can be statically bundled into the packaged main.

// Extract the battle roomid from a raw protocol frame (first line, e.g. ">battle-gen9ou-123").
export function roomidOf(frame) {
	if (!frame || frame[0] !== '>') return null;
	const nl = frame.indexOf('\n');
	const firstLine = (nl === -1 ? frame.slice(1) : frame.slice(1, nl)).trim();
	const m = firstLine.match(/^battle-[a-z0-9]+-\d+/);
	return m ? m[0] : null;
}

// Make a player/winner name safe for a filename (the log filename is a de-facto schema).
export function sanitize(name) {
	return (name || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
}

// Build the battle-log base filename (without extension). ts is passed in (not Date.now()) so the
// result is deterministic and testable. Scheme: <roomid>_[SPEC_]<p1>_vs_<p2>_<RESULT>_<ts>.
export function battleLogFilename(roomid, state, ts) {
	const p1 = sanitize(state.players?.p1?.name);
	const p2 = sanitize(state.players?.p2?.name);
	let resultToken;
	if (!state.ended) resultToken = 'INPROGRESS';
	else if (!state.winner) resultToken = 'TIE';
	else resultToken = `WIN_${sanitize(state.winner)}`;
	const prefix = state.mySide ? '' : 'SPEC_';
	return `${roomid}_${prefix}${p1}_vs_${p2}_${resultToken}_${ts}`;
}

// Decide whether a frame ends the battle (→ flush + write the log). |win|/|tie| always end it;
// |deinit| only counts past turn 1 so leaving a never-started room doesn't write an empty log.
// |tie is line-anchored: the real protocol frame is `|tie` with NO trailing pipe (one line of its
// own), so match the start of a line — not a bare /\|tie\|/, which never fired, and not /\|tie/,
// which would false-positive on chat lines like `|c|user|tie game`.
export function battleEndReason(frameData, turn) {
	if (/\|win\|/.test(frameData)) return 'win';
	if (/^\|tie\b/m.test(frameData)) return 'tie';
	if (/\|deinit/.test(frameData) && turn >= 1) return 'deinit';
	return null;
}
