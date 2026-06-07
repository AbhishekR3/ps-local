// Normalize any name (species/move/ability/item) to its lowercase alphanumeric id.
// Mirrors toID() in sim/dex-data.ts so our lookups key the same way the data files do.
export function toID(text) {
	if (typeof text !== 'string') {
		if (text) text = text.id || text.userid || text.roomid || text;
		if (typeof text === 'number') text = `${text}`;
		else if (typeof text !== 'string') return '';
	}
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
