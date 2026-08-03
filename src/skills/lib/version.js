import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Single source of truth for the version — read from package.json so it never drifts.
const here = path.dirname(fileURLToPath(import.meta.url))
let pkg = {};
try {
	pkg = JSON.parse(
		readFileSync(path.join(here, "..", "..", "..", "package.json"), "utf8"),
	);
} catch {
	// The package is expected in normal installs; retain a safe diagnostic fallback.
}
export const VERSION = pkg.version ?? "0.0.0";
