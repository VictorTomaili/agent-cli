// src/fields.js — XML-tag field schema + parsers for the identity .md files.
//
// Structured fields are stored as <TAG>value</TAG> so the CLI can detect gaps
// precisely: an empty/placeholder tag = a gap. This replaces prose-length guessing.
// Currently tagged: IDENTITY.md, SOUL.md, USER.md. (ENVIRONMENTS.md / LESSONS.md
// stay prose — they're freeform.)

export const ENVIRONMENT_FIELDS = [
	{ key: "ENV_LOCAL_USER", pattern: /^- User:\s*$/m },
	{ key: "ENV_LOCAL_OS", pattern: /^- OS:\s*$/m },
	{ key: "ENV_LOCAL_SHELL", pattern: /^- Shell:\s*$/m },
	{ key: "ENV_LOCAL_HOME", pattern: /^- Home:\s*$/m },
];

export function environmentGaps(content) {
	return ENVIRONMENT_FIELDS.filter((f) => f.pattern.test(content || "")).map(
		(f) => f.key,
	);
}

export const FIELD_TAGS = {
	identity: [
		{ tag: "AGENT_NAME", label: "Name", section: "Name" },
		{ tag: "AGENT_ROLE", label: "Role", section: "Role" },
		{ tag: "AGENT_MISSION", label: "Mission", section: "Mission" },
		{ tag: "AGENT_PERSONA", label: "Persona", section: "Persona" },
	],
	soul: [
		{ tag: "SOUL_PERSONALITY", label: "Personality", section: "Personality" },
		{ tag: "SOUL_VALUES", label: "Values", section: "Values" },
		{ tag: "SOUL_BELIEFS", label: "Beliefs", section: "Beliefs" },
		{
			tag: "SOUL_MOTIVATIONS",
			label: "Motivations & goals",
			section: "Motivations & goals",
		},
	],
	user: [
		{ tag: "USER_PREFS", label: "Preferences", section: "Preferences" },
		{ tag: "USER_GOALS", label: "Goals", section: "Goals" },
		{ tag: "USER_CONTEXT", label: "Context", section: "Context" },
	],
};

/** Infer the field-schema kind from a filename (IDENTITY.md → "identity", …). */
export function kindForFile(filename) {
	const base = (filename || "").toUpperCase();
	if (base === "IDENTITY.MD") return "identity";
	if (base === "SOUL.MD") return "soul";
	if (base === "USER.MD") return "user";
	return null;
}

/** Resolve a user-typed field name (tag / label / section) to a field def. */
export function resolveField(kind, name) {
	const fields = FIELD_TAGS[kind];
	if (!fields) return null;
	const n = name.trim();
	const up = n.toUpperCase();
	const low = n.toLowerCase();
	return (
		fields.find(
			(f) =>
				f.tag === up ||
				f.label.toLowerCase() === low ||
				f.section.toLowerCase() === low,
		) || null
	);
}

/** Read the inner content of <TAG>...</TAG>, or null if the tag is absent. */
export function readTag(content, tag) {
	const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
	return m ? m[1] : null;
}

/** Set the inner content of <TAG>...</TAG>; appends the tag at the end if absent. */
export function setTag(content, tag, value) {
	const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
	const replacement = `<${tag}>${value}</${tag}>`;
	if (re.test(content)) return content.replace(re, replacement);
	return `${content.trimEnd()}\n${replacement}\n`;
}

/** Is a tag's inner value a gap? (null/absent, empty, or a placeholder.) */
export function isPlaceholder(inner) {
	if (inner == null) return true;
	const t = inner.trim();
	if (!t) return true;
	if (/^\(.*\)$/s.test(t)) return true; // (your chosen name), (fill in), (e.g., …)
	if (/^<[^>]+>$/s.test(t)) return true;
	return false;
}

/** List the gap field tags for a kind in content (empty/placeholder), in schema order. */
export function fieldGaps(content, kind) {
	const fields = FIELD_TAGS[kind];
	if (!fields) return [];
	const gaps = [];
	for (const f of fields) {
		if (isPlaceholder(readTag(content, f.tag))) gaps.push(f.tag);
	}
	return gaps;
}
