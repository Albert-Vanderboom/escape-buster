// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import hljs from 'highlight.js';
import { generatePreviewHtml, escapeHtml, decodeHtmlEntities } from './webviewProvider';

// Register common languages that we want to detect and highlight
// This import is not needed when using the full highlight.js bundle
// import 'highlight.js/lib/common';

// Register additional languages as needed

/**
 * Format parsed content for consistent display in both hover and panel views
 */
function formatParsedContent(content: string, language: string | null): string {
	// Ensure HTML is properly escaped for display
	return escapeHtml(content);
}

// Helper to build a map of escape styles for each special character
function buildEscapeStyleMap(str: string): Record<string, 'unescaped' | 'escaped'> {
	const map: Record<string, 'unescaped' | 'escaped'> = {};
	const specials = [
		{ char: '\n', unescaped: /(^|[^\\])\n/, dbl: /\\n/ },
		{ char: '\r', unescaped: /(^|[^\\])\r/, dbl: /\\r/ },
		{ char: '\t', unescaped: /(^|[^\\])\t/, dbl: /\\t/ },
		{ char: '"', unescaped: /(^|[^\\])"/, dbl: /\\"/ },
		{ char: "'", unescaped: /(^|[^\\])'/, dbl: /\\'/ },
		{ char: '\\', unescaped: /(^|[^\\])\\(?![nrt"'\/])/, dbl: /\\\\/ },
		{ char: '\/', unescaped: /(^|[^\\])\//, dbl: /\\\// },
	];
	for (const { char, unescaped, dbl } of specials) {
		if (dbl.test(str)) map[char] = 'escaped';
		else if (unescaped.test(str)) map[char] = 'unescaped';
	}
	return map;
}

/**
 * Represents a preview panel for escaped strings
 */
class EscapePreviewPanel {
	public static currentPanel: EscapePreviewPanel | undefined;
	private static readonly viewType = 'escapePreview';
	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private _disposables: vscode.Disposable[] = [];

	public static createOrShow(extensionUri: vscode.Uri, content: string, title: string) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		// If we already have a panel, show it
		if (EscapePreviewPanel.currentPanel) {
			EscapePreviewPanel.currentPanel._panel.reveal(column);
			EscapePreviewPanel.currentPanel.update(content, title);
			return;
		}

		// Create a new panel
		const panel = vscode.window.createWebviewPanel(
			EscapePreviewPanel.viewType,
			'Escaped String Preview',
			{
				viewColumn: column || vscode.ViewColumn.Beside,
				preserveFocus: true
			},
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
			}
		);

		// Set initial dimensions
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const editorSize = editor.visibleRanges[0];
			const height = Math.max(600, editorSize.end.line - editorSize.start.line);
			// Note: This is a hint that might be ignored by VS Code
		}

		EscapePreviewPanel.currentPanel = new EscapePreviewPanel(panel, extensionUri);
		EscapePreviewPanel.currentPanel.update(content, title);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this._panel = panel;
		this._extensionUri = extensionUri;

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programmatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Listen for messages from the webview
		this._panel.webview.onDidReceiveMessage(
			async (message) => {
				if (message.command === 'editMultiline') {
					// Open a new untitled editor with the resolved string for editing
					const editor = vscode.window.activeTextEditor;
					let originalString = '';
					let stringRange: vscode.Range | undefined;
					let escapeStyle: 'unescaped' | 'escaped' = 'unescaped';
					let escapeMap: Record<string, 'unescaped' | 'escaped'> = {};
					if (editor) {
						const position = editor.selection.active;
						const { isInString, stringRange: range, stringContent } = isPositionInString(editor.document, position);
						if (isInString && range) {
							originalString = stringContent;
							stringRange = range;
							// Determine escape style
							escapeStyle = /\\\\[ntr"'\\/]/.test(stringContent) ? 'escaped' : 'unescaped';
							escapeMap = buildEscapeStyleMap(stringContent);
						}
					}
					// Only proceed if we have a string to edit
					if (!originalString) {
						vscode.window.showWarningMessage('No string detected at the cursor to edit.');
						return;
					}
					const resolvedString = parseEscapeSequences(originalString, originalString);
					const doc = await vscode.workspace.openTextDocument({ content: resolvedString, language: 'plaintext' });
					await vscode.window.showTextDocument(doc, { preview: false });
					// Store context for later replacement (could use a WeakMap or global state)
					let hoverLine: number | undefined = undefined;
					let hoverCharacter: number | undefined = undefined;
					// These will be provided by the hover context (should be set by the command)
					(globalThis as any)._escapeBusterEditContext = {
						originalString,
						stringRange,
						escapeStyle,
						escapeMap,
						documentUri: editor?.document.uri.toString(),
						hoverLine,
						hoverCharacter,
					};
				}
			},
			null,
			this._disposables
		);

		// Update the content based on view changes
		this._panel.onDidChangeViewState(
			e => {
				if (this._panel.visible) {
					// Not needed for now
				}
			},
			null,
			this._disposables
		);
	}

	public update(content: string, title: string) {
		const webview = this._panel.webview;
		this._panel.title = title;

		// Detect language for syntax highlighting
		const language = detectCodeLanguage(content);

		// Generate the HTML using the utility function
		webview.html = generatePreviewHtml(content, language);
	}

	public dispose() {
		EscapePreviewPanel.currentPanel = undefined;
		this._panel.dispose();

		while (this._disposables.length) {
			const disposable = this._disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
	}
}

/**
 * Check if the current position is within a string
 */
function isPositionInString(document: vscode.TextDocument, position: vscode.Position): { isInString: boolean, stringRange: vscode.Range | null, stringContent: string } {
	// Try to use the semantic token information if available
	const tokenType = document.getWordRangeAtPosition(position);
	if (tokenType) {
		// This is a simple approach, not perfect but helps with some cases
	}

	const line = document.lineAt(position.line).text;
	let inString = false;
	let stringStart = -1;
	let stringEnd = -1;
	let quoteChar = '';
	let escapeNext = false;

	// Simple parser for string detection with improved escape handling
	for (let i = 0; i < line.length; i++) {
		const char = line[i];

		// Handle escape sequences
		if (escapeNext) {
			escapeNext = false;
			continue;
		}

		if (char === '\\') {
			escapeNext = true;
			continue;
		}

		// Check for quotes
		if (char === '"' || char === "'") {
			if (!inString) {
				inString = true;
				stringStart = i;
				quoteChar = char;
			} else if (char === quoteChar) {
				inString = false;
				stringEnd = i;

				// If the position is within this string range, return true
				const positionInStringRange = position.character > stringStart && position.character < stringEnd;
				if (positionInStringRange) {
					const range = new vscode.Range(
						new vscode.Position(position.line, stringStart + 1),
						new vscode.Position(position.line, stringEnd)
					);
					return {
						isInString: true,
						stringRange: range,
						stringContent: line.substring(stringStart + 1, stringEnd)
					};
				}

				// Reset for the next string in the line
				stringStart = -1;
				stringEnd = -1;
				quoteChar = '';
			}
		}
	}

	// Check if still in a string at the end of parsing (incomplete string)
	if (inString && stringStart !== -1 && position.character > stringStart) {
		const range = new vscode.Range(
			new vscode.Position(position.line, stringStart + 1),
			new vscode.Position(position.line, line.length)
		);
		return {
			isInString: true,
			stringRange: range,
			stringContent: line.substring(stringStart + 1)
		};
	}

	return { isInString: false, stringRange: null, stringContent: '' };
}

/**
 * Convert escape sequences in a string to their real character representations for the multi-line editor.
 * Handles the following logic:
 * - If only escaped backslash escapes: convert escaped backslash sequences to real characters.
 * - If only unescaped backslash escapes: convert unescaped backslash sequences to real characters.
 * - If both: only convert unescaped backslash escapes, leave escaped backslash as literal text.
 * @param input The string to convert (the string content)
 * @param original The original string (to detect escape style)
 */
function parseEscapeSequences(input: string, original?: string): string {
	if (!input.includes('\\')) {
		return input;
	}
	// Build a map of escape styles for each special character sequence in the original string
	const escapeMap = original ? buildEscapeStyleMap(original) : {};
	// If no escapeMap, fallback to original logic
	if (!original) {
		// fallback: treat as unescaped
		return input
			.replace(/(?<!\\)\\n/g, '\n')
			.replace(/(?<!\\)\\t/g, '\t')
			.replace(/(?<!\\)\\r/g, '\r')
			.replace(/(?<!\\)\\"/g, '"')
			.replace(/(?<!\\)\\'/g, "'")
			.replace(/(?<!\\)\\\\/g, '\\')
			.replace(/(?<!\\)\\\//g, '/');
	}

	// For each supported escape sequence, replace according to the escapeMap
	// If both unescaped and escaped found for a char, default to unescaped
	const specials = [
		{ char: '\n', real: '\n', unescaped: /(?<!\\)\\n/g, escaped: /\\\\n/g },
		{ char: '\r', real: '\r', unescaped: /(?<!\\)\\r/g, escaped: /\\\\r/g },
		{ char: '\t', real: '\t', unescaped: /(?<!\\)\\t/g, escaped: /\\\\t/g },
		{ char: '"', real: '"', unescaped: /(?<!\\)\"/g, escaped: /\\\"/g },
		{ char: "'", real: "'", unescaped: /(?<!\\)\\'/g, escaped: /\\\\'/g },
		{ char: '\\', real: '\\', unescaped: /(?<!\\)\\\\/g, escaped: /\\\\\\/g },
		{ char: '\/', real: '/', unescaped: /(?<!\\)\\\//g, escaped: /\\\\\//g },
	];
	let result = input;
	for (const { char, real, unescaped, escaped } of specials) {
		const style = escapeMap[real];
		if (style === 'escaped') {
			// Only replace escaped backslash escapes
			result = result.replace(escaped, real);
		} else if (style === 'unescaped') {
			// Only replace unescaped backslash escapes
			result = result.replace(unescaped, real);
		} else if (style === undefined) {
			// Not found in original, try both (default to unescaped)
			result = result.replace(unescaped, real);
		} else {
			// If both unescaped and escaped found, default to unescaped
			result = result.replace(unescaped, real);
		}
	}
	return result;
}

/**
 * Check if a string contains escape sequences that we support
 */
function containsEscapeSequences(input: string): boolean {
	// Check if there are any escape sequences that are not escaped backslashes
	// Match any \ that is not preceded by another \, and is followed by one of our supported escape chars
	return /(?<!\\)\\[ntr"'\/]/.test(input);
}

/**
 * Detect code language using highlight.js
 */
function detectCodeLanguage(content: string): string | null {
	// Skip detection for very short content
	if (content.length < 10) {
		return null;
	}

	try {
		// Use highlight.js autodetection
		const result = hljs.highlightAuto(content, [
			'javascript', 'typescript', 'json',
			'html', 'xml', 'toml', 'yaml', 'css',
			'python', 'java', 'csharp', 'php', 'ruby', 'go', 'rust',
			'bash', 'shell', 'sql', 'c', 'cpp', 'text', 'markdown'
		]);

		// Check if there's a reliable detection
		if (result.language && result.relevance > 5) {
			return result.language;
		}

		// Return null if no reliable detection
		return null;
	} catch (error) {
		console.error('Language detection error:', error);
		return null;
	}
}

/**
 * Highlight code using highlight.js
 */
function highlightCode(content: string, language: string | null): string {
	try {
		if (language) {
			// Only highlight if we have a detected language
			return hljs.highlight(content, { language }).value;
		} else {
			// If no language detected, just return the original content
			return content;
		}
	} catch (error) {
		console.error('Syntax highlighting error:', error);
		return content; // Return original content if highlighting fails
	}
}

/**
 * Get the configuration for the extension
 */
function getConfiguration() {
	const config = vscode.workspace.getConfiguration('escapeBuster');
	return {
		enabledFileTypes: config.get<string[]>('enabledFileTypes') || ['json'],
		hoverDelay: config.get<number>('hoverDelay') || 300,
		enableAutoPreview: config.get<boolean>('enableAutoPreview') || true,
		defaultPreviewHeight: config.get<number>('defaultPreviewHeight') || 300
	};
}

/**
 * Helper to determine if a file should be processed based on its extension
 */
function isFileTypeEnabled(document: vscode.TextDocument): boolean {
	const config = getConfiguration();
	const fileExtension = document.fileName.split('.').pop() || '';

	// Accept both with and without dot prefix
	return config.enabledFileTypes.includes(fileExtension) ||
		config.enabledFileTypes.includes(`.${fileExtension}`);
}

/**
 * This method is called when your extension is activated
 */
export function activate(context: vscode.ExtensionContext) {
	// On activation, clean up any leftover temp folder
	try {
		const os = require('os');
		const tempDir = path.join(os.homedir(), 'escape-buster-tmp');
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
			console.log('[EscapeBuster] Cleaned up leftover temp folder:', tempDir);
		}
	} catch (err) {
		console.log('[EscapeBuster] Temp folder cleanup error:', err);
	}

	// Register the command to open the multi-line editor directly from hover (must be before hover provider)
	// Accepts either a string or an object with stringContent, hoverLine, hoverCharacter
	const editAsMultilineCommand = vscode.commands.registerCommand('escape-buster.editAsMultiline', async (arg?: any) => {
		try {
			let editor = vscode.window.activeTextEditor;
			let originalString = '';
			let stringRange: vscode.Range | undefined;
			let escapeStyle: 'unescaped' | 'escaped' = 'unescaped';
			let escapeMap: Record<string, 'unescaped' | 'escaped'> = {};
			let hoverLine: number | undefined = undefined;
			let hoverCharacter: number | undefined = undefined;
			if (arg && typeof arg === 'object' && arg.stringContent !== undefined && typeof arg.hoverLine === 'number' && typeof arg.hoverCharacter === 'number') {
				// Called from hover, with explicit mouse position
				originalString = arg.stringContent;
				hoverLine = arg.hoverLine;
				hoverCharacter = arg.hoverCharacter;
				// Try to get stringRange if possible
				if (
					typeof hoverLine === 'number' &&
					typeof hoverCharacter === 'number' &&
					editor && editor.document.uri.toString() === (editor?.document.uri.toString())
				) {
					const lineText = editor.document.lineAt(hoverLine).text;
					const idx = lineText.indexOf(originalString);
					if (idx !== -1) {
						stringRange = new vscode.Range(new vscode.Position(hoverLine, idx), new vscode.Position(hoverLine, idx + originalString.length));
					}
				}
				escapeStyle = /\\[ntr"'\\/]/.test(originalString) ? 'escaped' : 'unescaped';
				escapeMap = buildEscapeStyleMap(originalString);
			} else if (typeof arg === 'string') {
				originalString = arg;
				if (editor) {
					const position = editor.selection.active;
					const res = isPositionInString(editor.document, position);
					if (res.isInString && res.stringRange) {
						stringRange = res.stringRange;
						escapeMap = buildEscapeStyleMap(res.stringContent);
					}
				}
				escapeStyle = /\\[ntr"'\\/]/.test(originalString) ? 'escaped' : 'unescaped';
			} else if (!arg && editor) {
				const position = editor.selection.active;
				const res = isPositionInString(editor.document, position);
				if (res.isInString && res.stringRange) {
					originalString = res.stringContent;
					stringRange = res.stringRange;
					escapeStyle = /\\[ntr"'\\/]/.test(res.stringContent) ? 'escaped' : 'unescaped';
					escapeMap = buildEscapeStyleMap(res.stringContent);
				}
			}
			const resolvedString = parseEscapeSequences(originalString, originalString);
			// Store temp file in the user's home directory under escape-buster-tmp
			const os = require('os');
			let baseDir = path.join(os.homedir(), 'escape-buster-tmp');
			try {
				if (!fs.existsSync(baseDir)) {
					fs.mkdirSync(baseDir, { recursive: true });
				}
			} catch (err) {
				vscode.window.showErrorMessage('Escape Buster: Failed to create temp directory: ' + baseDir + ' - ' + err);
				return;
			}
			let tempFilePath = path.join(baseDir, 'String Editor');
			let fileNum = 1;
			while (fs.existsSync(tempFilePath)) {
				tempFilePath = path.join(baseDir, `String Editor ${fileNum}`);
				fileNum++;
			}
			try {
				fs.writeFileSync(tempFilePath, resolvedString, 'utf8');
				console.log('[EscapeBuster] Temp file created:', tempFilePath);
			} catch (err) {
				vscode.window.showErrorMessage('Escape Buster: Failed to write temp file: ' + tempFilePath + ' - ' + err);
				return;
			}
			let realTempFilePath;
			try {
				realTempFilePath = fs.realpathSync(tempFilePath);
			} catch (err) {
				vscode.window.showErrorMessage('Escape Buster: Failed to resolve temp file path: ' + tempFilePath + ' - ' + err);
				return;
			}
			let doc;
			try {
				doc = await vscode.workspace.openTextDocument(realTempFilePath);
			} catch (err) {
				vscode.window.showErrorMessage('Escape Buster: Failed to open temp file: ' + realTempFilePath + ' - ' + err);
				return;
			}
			try {
				await vscode.window.showTextDocument(doc, { preview: false });
			} catch (err) {
				vscode.window.showErrorMessage('Escape Buster: Failed to show temp file in editor: ' + err);
				return;
			}
			(globalThis as any)._escapeBusterEditContext = {
				originalString,
				stringRange,
				escapeStyle,
				escapeMap,
				documentUri: editor?.document.uri.toString(),
				tempFilePath: realTempFilePath,
				wasSaved: false,
				hoverLine,
				hoverCharacter,
			};
		} catch (err) {
			vscode.window.showErrorMessage('Escape Buster: Unexpected error: ' + err);
		}
	});

	context.subscriptions.push(editAsMultilineCommand);

	// When the temp file is saved, immediately take over the change into the original file as string
	vscode.workspace.onDidSaveTextDocument(async (doc) => {
		const ctx = (globalThis as any)._escapeBusterEditContext;
		if (!ctx || !ctx.tempFilePath) return;
		let docPath = doc.uri.fsPath;
		try { docPath = fs.realpathSync(docPath); } catch { }
		if (docPath !== ctx.tempFilePath) return;
		const editedText = doc.getText();
		// Only update if the edited text is different from the original string
		let stringRange = ctx.stringRange;
		// If stringRange is missing, search for the original string in the correct line and character
		if (!stringRange && ctx.documentUri && typeof ctx.originalString === 'string' && typeof ctx.hoverLine === 'number' && typeof ctx.hoverCharacter === 'number') {
			// Find the original document in all open text documents
			let origDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === ctx.documentUri);
			if (origDoc) {
				const lineText = origDoc.lineAt(ctx.hoverLine).text;
				const searchStr = ctx.originalString;
				let idx = -1;
				let foundRange: vscode.Range | undefined = undefined;
				// Search all occurrences in the line
				while (true) {
					idx = lineText.indexOf(searchStr, idx + 1);
					if (idx === -1) break;
					// If hoverCharacter is within this occurrence, use it
					if (ctx.hoverCharacter >= idx && ctx.hoverCharacter <= idx + searchStr.length) {
						const start = new vscode.Position(ctx.hoverLine, idx);
						const end = new vscode.Position(ctx.hoverLine, idx + searchStr.length);
						foundRange = new vscode.Range(start, end);
						break;
					}
				}
				if (foundRange) {
					stringRange = foundRange;
				}
			}
		}
		if (
			editedText &&
			ctx.documentUri &&
			stringRange &&
			typeof ctx.originalString === 'string' &&
			editedText !== parseEscapeSequences(ctx.originalString, ctx.originalString)
		) {
			// Find the original document in all open text documents
			let origDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === ctx.documentUri);
			if (origDoc) {
				// Show the document in an editor
				const origEditor = await vscode.window.showTextDocument(origDoc, { preview: false, preserveFocus: true });
				await origEditor.edit(editBuilder => {
					editBuilder.replace(stringRange, multiLineToEscapedString(editedText, ctx.escapeStyle, ctx.escapeMap, ctx.originalString));
				});
			}
		} else if (!stringRange) {
			vscode.window.showWarningMessage('Escape Buster: Could not determine string range for replacement.');
		}
		ctx.wasSaved = true;
		ctx.lastSavedText = editedText;

		// Close the String Editor tab after save
		try {
			const tempDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === ctx.tempFilePath);
			if (tempDoc) {
				await vscode.window.showTextDocument(tempDoc, { preview: false });
				await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			}
		} catch (err) {
			console.log('[EscapeBuster] Could not close String Editor tab:', err);
		}
	});

	// On tab close, delete the temp file and clear context. Only update original if file was saved.
	vscode.window.onDidChangeVisibleTextEditors(async (editors) => {
		const ctx = (globalThis as any)._escapeBusterEditContext;
		if (!ctx || !ctx.tempFilePath) return;
		// If no open text document is showing the temp file, take over the string and delete the file/folder
		const stillOpen = vscode.workspace.textDocuments.some(d => d.uri.fsPath === ctx.tempFilePath);
		if (!stillOpen) {
			setTimeout(async () => {
				try {
					// Take over the string only if changed from original
					let editedText = ctx.lastSavedText;
					if (!editedText && fs.existsSync(ctx.tempFilePath)) {
						editedText = fs.readFileSync(ctx.tempFilePath, 'utf8');
					}
					// Only update if the edited text is different from the original string
					if (
						editedText &&
						ctx.documentUri &&
						ctx.stringRange &&
						typeof ctx.originalString === 'string' &&
						editedText !== parseEscapeSequences(ctx.originalString, ctx.originalString)
					) {
						// Find the original editor, or open it if not visible
						let origEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === ctx.documentUri);
						if (!origEditor) {
							// Open the original document in the background
							const origDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === ctx.documentUri);
							if (origDoc) {
								origEditor = await vscode.window.showTextDocument(origDoc, { preview: false, preserveFocus: true });
							}
						}
						if (origEditor) {
							await origEditor.edit(editBuilder => {
								editBuilder.replace(ctx.stringRange, multiLineToEscapedString(editedText, ctx.escapeStyle, ctx.escapeMap, ctx.originalString));
							});
						}
					}
					const tempDir = require('path').dirname(ctx.tempFilePath);
					if (fs.existsSync(ctx.tempFilePath)) {
						fs.unlinkSync(ctx.tempFilePath);
						console.log('[EscapeBuster] Temp file deleted:', ctx.tempFilePath);
					}
					// Remove the whole temp folder and its contents
					if (fs.existsSync(tempDir)) {
						fs.rmSync(tempDir, { recursive: true, force: true });
						console.log('[EscapeBuster] Temp folder deleted:', tempDir);
					}
				} catch (err) {
					console.log('[EscapeBuster] Temp file/folder delete error:', err);
				}
			}, 500);
			(globalThis as any)._escapeBusterEditContext = undefined;
		}
	});

	// Utility: Convert multi-line text to escaped string
	function multiLineToEscapedString(text: string, style: 'unescaped' | 'escaped', escapeMap?: Record<string, 'unescaped' | 'escaped'>, original?: string): string {
		// For robust per-character escape, process the string char by char, using escapeMap if provided
		let result = '';
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			let origStyle = style;
			if (escapeMap && escapeMap[ch]) {
				origStyle = escapeMap[ch];
			}
			switch (ch) {
				case '\n':
					result += origStyle === 'escaped' ? '\\\\n' : '\\n';
					break;
				case '\r':
					result += origStyle === 'escaped' ? '\\\\r' : '\\r';
					break;
				case '\t':
					result += origStyle === 'escaped' ? '\\\\t' : '\\t';
					break;
				case '"':
					result += origStyle === 'escaped' ? '\\"' : '"';
					break;
				case "'":
					result += origStyle === 'escaped' ? "\\'" : "'";
					break;
				case '\\':
					result += origStyle === 'escaped' ? '\\\\' : '\\';
					break;
				case '/':
					result += origStyle === 'escaped' ? '\\/' : '/';
					break;
				default:
					result += ch;
			}
		}
		return result;
	}

	console.log('Extension "escape-buster" is now active');

	// Add debug output for activation
	vscode.window.showInformationMessage('EscapeBuster extension is now active!');

	// Get enabled file types from user configuration
	const config = getConfiguration();

	// Setup configuration change listener to dynamically update hover providers
	// when user changes enabledFileTypes setting
	let currentHoverProvider: vscode.Disposable | undefined;

	// Function to register or re-register hover providers based on current config
	function registerHoverProviders() {
		// Dispose previous hover provider if exists
		if (currentHoverProvider) {
			currentHoverProvider.dispose();
		}

		// Get current configuration
		const currentConfig = getConfiguration();

		// Create document selectors for all enabled file types
		const documentSelectors: vscode.DocumentFilter[] = [];

		for (const fileType of currentConfig.enabledFileTypes) {
			// Handle file types with or without dot prefix
			const fileExtension = fileType.startsWith('.') ? fileType.substring(1) : fileType;

			// Add document filter based on language ID
			documentSelectors.push({ language: fileExtension });

			// Also add support for extension pattern (for files without registered language)
			documentSelectors.push({ pattern: `**/*.${fileExtension}` });
		}

		// Register hover provider for all enabled file types
		currentHoverProvider = vscode.languages.registerHoverProvider(
			documentSelectors,
			{
				provideHover(document, position, token) {
					// Check if the file type is enabled in user settings
					// This is now redundant but kept for double-checking
					if (!isFileTypeEnabled(document)) {
						return null;
					}

					// Check if position is inside a string
					const { isInString, stringRange, stringContent } = isPositionInString(document, position);
					if (!isInString || !stringRange) {
						return null;
					}

					// Check if the string contains escape sequences
					if (!containsEscapeSequences(stringContent)) {
						return null;
					}

					// Parse the escape sequences
					const parsedContent = parseEscapeSequences(stringContent, stringContent);

					// Detect language for syntax highlighting
					const language = detectCodeLanguage(parsedContent);

					// Create a markdown string for the hover with links at the top
					const markdownContent = new vscode.MarkdownString();
					markdownContent.appendMarkdown('### Escaped String Preview');
					// Pass stringContent, line, and character to the command as an object
					const hoverArgs = {
						stringContent,
						hoverLine: position.line,
						hoverCharacter: position.character
					};
					markdownContent.appendMarkdown(
						'\n\n[Show in Preview Panel](command:escape-buster.previewEscapedString?' +
						encodeURIComponent(JSON.stringify([stringContent])) +
						')  |  [Edit as Multi-line](command:escape-buster.editAsMultiline?' +
						encodeURIComponent(JSON.stringify([hoverArgs])) + ')\n\n'
					);
					// Add language identifier if detected
					if (language) {
						markdownContent.appendCodeblock(parsedContent, language);
					} else {
						markdownContent.appendCodeblock(parsedContent);
					}

					markdownContent.isTrusted = true;

					return new vscode.Hover(markdownContent, stringRange);
				}
			}
		);

		// Add to subscriptions for proper disposal
		context.subscriptions.push(currentHoverProvider);
	}

	// Initial registration
	registerHoverProviders();

	// Listen for configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('escapeBuster.enabledFileTypes')) {
				registerHoverProviders();
			}
		})
	);

	// Register the command to open the preview panel
	const previewCommand = vscode.commands.registerCommand('escape-buster.previewEscapedString', (stringContent?: string) => {
		if (!stringContent && vscode.window.activeTextEditor) {
			const editor = vscode.window.activeTextEditor;
			const position = editor.selection.active;
			const { isInString, stringContent: content } = isPositionInString(editor.document, position);

			if (isInString && content) {
				stringContent = content;
			} else {
				vscode.window.showInformationMessage('No string found at cursor position');
				return;
			}
		}

		if (stringContent) {
			const parsedContent = parseEscapeSequences(stringContent, stringContent);
			// Use the same language detection as the hover preview
			const language = detectCodeLanguage(parsedContent);
			// Create a title that includes the language if detected
			const title = language ? `Escaped String Preview (${language})` : 'Escaped String Preview';
			EscapePreviewPanel.createOrShow(context.extensionUri, parsedContent, title);
		}
	});

	context.subscriptions.push(previewCommand);
}

/**
 * This method is called when your extension is deactivated
 */
export function deactivate() {
	// Clean-up code if needed
}
