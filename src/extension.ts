import * as vscode from 'vscode';
import { extractTypeNames, findTypeNameInLines, selectWorkspaceSymbolMatch } from './typeExtraction';

const LANGUAGES = [
	{ language: 'typescript' },
	{ language: 'typescriptreact' },
	{ language: 'javascript' },
	{ language: 'javascriptreact' },
];

const COMMAND_ID = 'tsClickableTypes.goToTypeDefinition';

// Blocks recursion when our hover provider triggers `executeHoverProvider`,
// which would otherwise call us again for the same position. Keyed per
// document+position so concurrent hovers in different editors don't interfere.
const activeRequests = new Set<string>();

let outputChannel: vscode.OutputChannel | undefined;

let userExclusions = new Set<string>();

function refreshExclusions() {
	const config = vscode.workspace.getConfiguration('tsClickableTypes');
	userExclusions = new Set(config.get<string[]>('excludeTypes', []));
}

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('TS Clickable Types');
	refreshExclusions();
	context.subscriptions.push(
		outputChannel,
		vscode.commands.registerCommand(COMMAND_ID, goToTypeDefinition),
		vscode.languages.registerHoverProvider(LANGUAGES, { provideHover }),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('tsClickableTypes.excludeTypes')) {
				refreshExclusions();
			}
		}),
	);
}

export function deactivate() {
	outputChannel = undefined;
	activeRequests.clear();
	userExclusions = new Set();
}

// ---------------------------------------------------------------------------
// Hover Provider
// ---------------------------------------------------------------------------
async function provideHover(
	document: vscode.TextDocument,
	position: vscode.Position,
	token: vscode.CancellationToken,
): Promise<vscode.Hover | undefined> {
	const requestKey = `${document.uri.toString()}#${position.line}:${position.character}`;
	if (activeRequests.has(requestKey)) {
		return undefined;
	}

	activeRequests.add(requestKey);
	try {
		const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
			'vscode.executeHoverProvider',
			document.uri,
			position,
		);

		if (token.isCancellationRequested) {
			return undefined;
		}

		if (!hovers || hovers.length === 0) {
			return undefined;
		}

		// Collect all hover text so we can scan for type names
		let combinedText = '';
		for (const hover of hovers) {
			for (const content of hover.contents) {
				const md = toMarkdownString(content);
				if (md) {
					combinedText += md.value + '\n';
				}
			}
		}

		const typeNames = extractTypeNames(combinedText, userExclusions);
		if (typeNames.length === 0) {
			return undefined;
		}

		// Build clickable links for each detected type
		const baseArgs = {
			uri: document.uri.toString(),
			line: position.line,
			character: position.character,
		};

		const links = typeNames.map((name) => {
			const encoded = encodeURIComponent(
				JSON.stringify({ ...baseArgs, typeName: name }),
			);
			return `[${name}](command:${COMMAND_ID}?${encoded} "Jump to ${name}")`;
		});

		const linksRow = new vscode.MarkdownString(
			`🔗 **Go to type:** ${links.join('&ensp;·&ensp;')}`,
		);
		linksRow.isTrusted = true;

		return new vscode.Hover(linksRow);
	} finally {
		activeRequests.delete(requestKey);
	}
}

// ---------------------------------------------------------------------------
// Command: Go to Type Definition
// ---------------------------------------------------------------------------
async function goToTypeDefinition(args: {
	uri: string;
	line: number;
	character: number;
	typeName: string;
}): Promise<void> {
	const uri = vscode.Uri.parse(args.uri);

	const ALLOWED_SCHEMES = new Set(['file', 'vscode-vfs', 'untitled']);
	if (!ALLOWED_SCHEMES.has(uri.scheme)) {
		return;
	}

	const hoverPosition = new vscode.Position(args.line, args.character);

	// Strategy 1: Find the type name in the source text near the hover position,
	// then ask the TS language server for its type definition.
	if (await tryTypeDefinitionProvider(uri, hoverPosition, args.typeName)) {
		return;
	}

	// Strategy 2: Fall back to workspace symbol search.
	if (await tryWorkspaceSymbolSearch(args.typeName)) {
		return;
	}

	vscode.window.showInformationMessage(
		`Could not find definition for type: ${args.typeName}`,
	);
}

async function tryTypeDefinitionProvider(
	uri: vscode.Uri,
	hoverPosition: vscode.Position,
	typeName: string,
): Promise<boolean> {
	try {
		const document = await vscode.workspace.openTextDocument(uri);
		const typePos = findTypeNamePosition(document, hoverPosition, typeName);

		// If the type name isn't in the source near the hover position (e.g. it's
		// a generic parameter only visible in the hover text), fall through to the
		// workspace symbol search rather than resolving the wrong type at hoverPosition.
		if (!typePos) {
			return false;
		}

		const locations = await vscode.commands.executeCommand<
			(vscode.Location | vscode.LocationLink)[]
		>('vscode.executeTypeDefinitionProvider', uri, typePos);

		if (locations && locations.length > 0) {
			const loc = locations[0];
			// `targetRange` exists on LocationLink only; using it as the discriminator
			// is more reliable than `targetUri` (which collides with similarly-named ad-hoc objects).
			const isLink = 'targetRange' in loc;
			const targetUri = isLink ? loc.targetUri : loc.uri;
			const targetRange = isLink
				? loc.targetSelectionRange ?? loc.targetRange
				: loc.range;
			await vscode.window.showTextDocument(targetUri, {
				selection: targetRange,
				preview: false,
			});
			return true;
		}
	} catch (err) {
		outputChannel?.appendLine(`[tryTypeDefinitionProvider] ${err}`);
	}
	return false;
}

async function tryWorkspaceSymbolSearch(typeName: string): Promise<boolean> {
	try {
		const symbols = await vscode.commands.executeCommand<
			vscode.SymbolInformation[]
		>('vscode.executeWorkspaceSymbolProvider', typeName);

		const match = selectWorkspaceSymbolMatch(symbols ?? [], typeName);
		if (!match) {
			return false;
		}

		const chosen =
			match.kind === 'single'
				? symbols[match.index]
				: await promptForSymbol(match.indices.map((i) => symbols[i]), typeName);

		if (!chosen) {
			// User cancelled the picker — still counts as handled.
			return true;
		}

		await vscode.window.showTextDocument(chosen.location.uri, {
			selection: chosen.location.range,
			preview: false,
		});
		return true;
	} catch (err) {
		outputChannel?.appendLine(`[tryWorkspaceSymbolSearch] ${err}`);
	}
	return false;
}

async function promptForSymbol(
	candidates: vscode.SymbolInformation[],
	typeName: string,
): Promise<vscode.SymbolInformation | undefined> {
	const items = candidates.map((sym) => ({
		label: sym.name,
		description: vscode.SymbolKind[sym.kind],
		detail: vscode.workspace.asRelativePath(sym.location.uri),
		symbol: sym,
	}));
	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: `Multiple definitions for "${typeName}" — pick one`,
		matchOnDescription: true,
		matchOnDetail: true,
	});
	return picked?.symbol;
}

// ---------------------------------------------------------------------------
// Find the position of a type name in the document near the hover position
// ---------------------------------------------------------------------------
function findTypeNamePosition(
	document: vscode.TextDocument,
	hoverPosition: vscode.Position,
	typeName: string,
): vscode.Position | null {
	const result = findTypeNameInLines(
		(i) => document.lineAt(i).text,
		document.lineCount,
		hoverPosition.line,
		hoverPosition.character,
		typeName,
	);
	return result ? new vscode.Position(result.line, result.character) : null;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function toMarkdownString(
	content: vscode.MarkdownString | vscode.MarkedString,
): vscode.MarkdownString | null {
	if (content instanceof vscode.MarkdownString) {
		return content;
	}
	if (typeof content === 'string') {
		return new vscode.MarkdownString(content);
	}
	if (typeof content === 'object' && 'value' in content && 'language' in content) {
		const md = new vscode.MarkdownString();
		md.appendCodeblock(content.value, content.language);
		return md;
	}
	return null;
}
