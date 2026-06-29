// ---------------------------------------------------------------------------
// Built-in / global TypeScript types we do NOT want to show as "jump" links
// ---------------------------------------------------------------------------
export const BUILTIN_TYPES = new Set([
	// Core utility types
	'Array', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
	'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
	'Extract', 'Exclude', 'ReturnType', 'InstanceType', 'Parameters',
	'ConstructorParameters', 'NonNullable', 'Awaited',
	'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize',
	'TemplateStringsArray', 'PropertyKey', 'ClassDecorator',
	// Primitives & wrappers
	'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
	'Function', 'RegExp', 'Date',
	// Errors
	'Error', 'TypeError', 'RangeError', 'ReferenceError',
	'SyntaxError', 'URIError', 'EvalError',
	// Buffers & typed arrays
	'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
	'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
	'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
	'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
	// Iterables & generators
	'Generator', 'AsyncGenerator', 'Iterator', 'AsyncIterator',
	'Iterable', 'AsyncIterable', 'IterableIterator', 'AsyncIterableIterator',
	'ReadonlyArray', 'ReadonlyMap', 'ReadonlySet',
	'PromiseLike', 'Thenable',
	// DOM & Web APIs
	'EventTarget', 'Event', 'CustomEvent', 'AbortSignal', 'AbortController',
	'URL', 'URLSearchParams', 'FormData', 'Headers', 'Request', 'Response',
	'ReadableStream', 'WritableStream', 'TransformStream',
	'Blob', 'File', 'FileList', 'FileReader',
	'Worker', 'MessageEvent', 'MessageChannel', 'MessagePort',
	'Window', 'Document', 'Element', 'HTMLElement', 'SVGElement',
	'Node', 'NodeList', 'Attr', 'Console',
	'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
	'Storage', 'Navigator', 'Location', 'History',
	'XMLHttpRequest', 'WebSocket', 'EventSource',
	'Performance', 'PerformanceObserver',
	'Proxy', 'Reflect', 'JSON', 'Math', 'Intl',
	// React namespace & common React types
	// (FC, SFC, VFC, JSX are all-caps and excluded automatically by the
	//  lowercase-letter requirement in PASCAL_CASE — no need to list them.)
	'React',
	'ReactNode', 'ReactElement', 'ReactChild', 'ReactChildren', 'ReactFragment', 'ReactPortal',
	'ComponentType', 'ComponentProps', 'ComponentClass', 'FunctionComponent',
	'PropsWithChildren', 'PropsWithRef', 'PropsWithoutRef',
	'CSSProperties', 'RefObject', 'MutableRefObject', 'Ref', 'ForwardedRef',
	'Dispatch', 'SetStateAction',
	// Node.js
	'Buffer', 'NodeJS', 'Process', 'IArguments',
	// TS utility & global types
	'NoInfer', 'CallableFunction', 'NewableFunction',
]);

// ---------------------------------------------------------------------------
// Module-scoped regex constants — hoisted to avoid per-call recompilation.
// All use the `g` flag; callers must reset lastIndex = 0 before each use.
//
// IMPORTANT: extractTypeNames must remain fully synchronous. The shared regex
// state (lastIndex) would corrupt if two calls interleaved across an `await`.
// ---------------------------------------------------------------------------

// Excludes the declared symbol name (e.g. "X" from "type X = ..." or "const X: ...").
// Covers all declaration keywords so hovering on a declaration doesn't self-link.
const SYMBOL_PATTERN = /(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Z][a-zA-Z0-9_]*)/g;

// Matches fenced code blocks in hover markdown.
const FENCED_BLOCK = /```[\w]*\n([\s\S]*?)\n```/g;

// Matches inline code spans in hover markdown.
const INLINE_CODE = /`([^`\n]+)`/g;

// Matches PascalCase identifiers — requires at least one lowercase letter to
// exclude ALL_CAPS constants (e.g. MAX_RETRY, API_KEY) which are not types.
// Single-letter generic parameters (T, K, V) intentionally do NOT match;
// they're context-bound and rarely useful as navigation targets.
const PASCAL_CASE = /\b([A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*)\b/g;

// ---------------------------------------------------------------------------
// Type name extraction from hover markdown text
// ---------------------------------------------------------------------------
export function extractTypeNames(
	hoverText: string,
	additionalExclusions?: ReadonlySet<string>,
): string[] {
	const found = new Set<string>();

	// Collect code block contents first so SYMBOL_PATTERN only scans actual
	// code — prose like "you can use type X" must not exclude X.
	const codeBlocks: string[] = [];

	FENCED_BLOCK.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FENCED_BLOCK.exec(hoverText)) !== null) {
		codeBlocks.push(m[1]);
	}

	INLINE_CODE.lastIndex = 0;
	while ((m = INLINE_CODE.exec(hoverText)) !== null) {
		codeBlocks.push(m[1]);
	}

	// Exclude the declared symbol name (e.g. "X" from "const X: ...")
	// since it's the variable/function name, not a type reference.
	const symbolNames = new Set<string>();
	for (const code of codeBlocks) {
		SYMBOL_PATTERN.lastIndex = 0;
		let s: RegExpExecArray | null;
		while ((s = SYMBOL_PATTERN.exec(code)) !== null) {
			symbolNames.add(s[1]);
		}
	}

	for (const code of codeBlocks) {
		scanForPascalCaseTypes(code, found, symbolNames, additionalExclusions);
	}

	return Array.from(found);
}

export function scanForPascalCaseTypes(
	code: string,
	found: Set<string>,
	exclude: Set<string>,
	additionalExclusions?: ReadonlySet<string>,
): void {
	PASCAL_CASE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = PASCAL_CASE.exec(code)) !== null) {
		const name = m[1];
		if (!BUILTIN_TYPES.has(name) && !exclude.has(name) && !additionalExclusions?.has(name)) {
			found.add(name);
		}
	}
}

// ---------------------------------------------------------------------------
// Workspace symbol disambiguation
// ---------------------------------------------------------------------------

// vscode.SymbolKind values for things that are actually types. Duplicated here
// (rather than imported) so this module stays vscode-free and unit-testable.
// Numbers match the vscode.SymbolKind enum: Class=4, Interface=10, Enum=9,
// TypeParameter=25, Struct=22.
const TYPE_SYMBOL_KINDS: ReadonlySet<number> = new Set([4, 9, 10, 22, 25]);

export type SymbolMatchResult =
	| { kind: 'single'; index: number }
	| { kind: 'multiple'; indices: number[] };

/**
 * Chooses the best match for a typed workspace-symbol lookup.
 * - Prefers exact-name matches whose SymbolKind is a type (class/interface/enum/…)
 * - Falls back to any exact-name match
 * - Falls back to the first symbol
 * Returns 'multiple' when several equally-good candidates exist so the caller
 * can prompt the user instead of guessing.
 */
export function selectWorkspaceSymbolMatch(
	symbols: ReadonlyArray<{ name: string; kind: number }>,
	typeName: string,
): SymbolMatchResult | null {
	if (symbols.length === 0) {
		return null;
	}

	const typedNameMatches: number[] = [];
	const nameMatches: number[] = [];
	for (let i = 0; i < symbols.length; i++) {
		if (symbols[i].name === typeName) {
			nameMatches.push(i);
			if (TYPE_SYMBOL_KINDS.has(symbols[i].kind)) {
				typedNameMatches.push(i);
			}
		}
	}

	if (typedNameMatches.length === 1) {
		return { kind: 'single', index: typedNameMatches[0] };
	}
	if (typedNameMatches.length > 1) {
		return { kind: 'multiple', indices: typedNameMatches };
	}
	if (nameMatches.length === 1) {
		return { kind: 'single', index: nameMatches[0] };
	}
	if (nameMatches.length > 1) {
		return { kind: 'multiple', indices: nameMatches };
	}
	return { kind: 'single', index: 0 };
}

export function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Pure position search — extracted so it can be unit-tested without VS Code
// ---------------------------------------------------------------------------

export interface LinePosition {
	line: number;
	character: number;
}

type LineReader = (lineNumber: number) => string;

/**
 * Finds the position of a type name in lines near a hover location.
 * Searches the hovered line first (preferring the match closest to the hover
 * character), then falls back to surrounding lines within searchRange.
 * Only calls readLine for lines within the window — never materializes the
 * full document. Returns null if the type name is not found.
 */
export function findTypeNameInLines(
	readLine: LineReader,
	totalLines: number,
	hoverLine: number,
	hoverCharacter: number,
	typeName: string,
	searchRange = 5,
): LinePosition | null {
	if (totalLines === 0) {
		return null;
	}

	const regex = new RegExp(`\\b${escapeRegExp(typeName)}\\b`, 'g');
	const startLine = Math.max(0, hoverLine - searchRange);
	const endLine = Math.min(totalLines - 1, hoverLine + searchRange);

	// Search hovered line first, preferring match closest to hover character
	let bestMatch: LinePosition | null = null;
	let bestDistance = Infinity;
	let m: RegExpExecArray | null;

	regex.lastIndex = 0;
	while ((m = regex.exec(hoverLine < totalLines ? readLine(hoverLine) : '')) !== null) {
		const dist = Math.abs(m.index - hoverCharacter);
		if (dist < bestDistance) {
			bestDistance = dist;
			bestMatch = { line: hoverLine, character: m.index };
		}
	}
	if (bestMatch) {
		return bestMatch;
	}

	// Fall back to surrounding lines, ordered by distance from hover line so
	// the closest match wins (tie-breaker: line above, then line below).
	for (let offset = 1; offset <= searchRange; offset++) {
		for (const line of [hoverLine - offset, hoverLine + offset]) {
			if (line < startLine || line > endLine) {
				continue;
			}
			regex.lastIndex = 0;
			const match = regex.exec(readLine(line));
			if (match) {
				return { line, character: match.index };
			}
		}
	}

	return null;
}
