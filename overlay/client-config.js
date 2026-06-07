// ps-local overlay — DO NOT EDIT this copy in vendor/. Edit overlay/client-config.js and run
// `npm run apply-overlay`. apply-overlay copies this onto the gitignored
// vendor/pokemon-showdown-client/config/config.js.
//
// SECONDARY BY DESIGN: our entry point testclient-new.html loads config.js from the public site and
// is pointed at the local server via the ?~~localhost:8000 URL param (parsed in testclient-new.html),
// so this local config.js does not govern the testclient path. It exists for completeness and for the
// non-testclient client entry. See overlay/README.md.
var Config = Config || {};

Config.defaultserver = {
	id: 'localhost',
	host: 'localhost',
	port: 8000,
	httpport: 8000,
	altport: 80,
	registered: false,
};
