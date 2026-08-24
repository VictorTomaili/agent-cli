// src/targets.js — backward-compatibility re-export of src/targets/index.js.
//
// The target registry was refactored into per-target files under
// src/targets/<id>.js with the central loader in src/targets/index.js.
// This module is preserved as a thin re-export so every existing import
// (`import { TARGETS, getTarget } from "./targets.js"`) keeps working
// without edits. New code should import from `./targets/index.js` directly
// to make the location explicit.

export {
	TARGETS,
	TARGET_MAP,
	getTarget,
	knownIds,
	pathFor,
	scopesFor,
	targetsWithScope,
	targetsWithHooks,
	adaptContent,
	cursorTransform,
} from "./targets/index.js";