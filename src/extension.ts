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

/**
 * Build a map to determine the escape style for each special character in the string.
 * The map keys are the actual characters (e.g., '\n', '/', '\\'), and values indicate
 * whether they should be encoded as single-backslash ('\n') or double-backslash ('\\n').
 * 
 * Strategy:
 * - If we find double-backslash sequences like '\\n', '\\/', we mark those as 'double-escaped'
 * - If we find single-backslash sequences like '\n', '\/', we mark those as 'single-escaped'
 * - This helps preserve the original escape style when converting back
 */
function buildEscapeStyleMap(str: string): Record<string, 'single-escaped' | 'double-escaped'> {
	const map: Record<string, 'single-escaped' | 'double-escaped'> = {};
	
	// Check for double-backslash escape sequences (\\n, \\t, \\/, etc.)
	// These appear in the source as four characters: \ \ n or \ \ /
	if (/\\\\n/.test(str)) {
		map['\n'] = 'double-escaped';
	}
	if (/\\\\r/.test(str)) {
		map['\r'] = 'double-escaped';
	}
	if (/\\\\t/.test(str)) {
		map['\t'] = 'double-escaped';
	}
	if (/\\\\['"]/.test(str)) {
		map['"'] = 'double-escaped';
		map["'"] = 'double-escaped';
	}
	if (/\\\\\\\\/.test(str)) {
		map['\\'] = 'double-escaped';
	}
	if (/\\\\\//g.test(str)) {
		map['/'] = 'double-escaped';
	}
	
	// Check for single-backslash escape sequences (\n, \t, \/, etc.)
	// These appear in the source as two characters: \ n or \ /
	// Only mark as single-escaped if not already marked as double-escaped
	if (!map['\n'] && /\\n/.test(str)) {
		map['\n'] = 'single-escaped';
	}
	if (!map['\r'] && /\\r/.test(str)) {
		map['\r'] = 'single-escaped';
	}
	if (!map['\t'] && /\\t/.test(str)) {
		map['\t'] = 'single-escaped';
	}
	if (!map['"'] && /\\"/.test(str)) {
		map['"'] = 'single-escaped';
	}
	if (!map["'"] && /\\'/.test(str)) {
		map["'"] = 'single-escaped';
	}
	if (!map['\\'] && /\\\\/.test(str)) {
		map['\\'] = 'single-escaped';
	}
	if (!map['/'] && /\\\//.test(str)) {
		map['/'] = 'single-escaped';
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
					let escapeStyle: 'single-escaped' | 'double-escaped' = 'single-escaped';
					let escapeMap: Record<string, 'single-escaped' | 'double-escaped'> = {};
					if (editor) {
						const position = editor.selection.active;
						const { isInString, stringRange: range, stringContent } = isPositionInString(editor.document, position);
						if (isInString && range) {
							originalString = stringContent;
							stringRange = range;
							// Determine escape style - check if it has double-escaped sequences
							escapeStyle = /\\\\[ntr"'\\/]/.test(stringContent) ? 'double-escaped' : 'single-escaped';
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
 * This function decodes string literals (as they appear in source code) into actual characters.
 * 
 * Examples:
 * - Input: "hello\\nworld" (source with \n) -> Output: "hello\nworld" (actual newline)
 * - Input: "url\\/path" (source with \/) -> Output: "url/path" (actual slash)
 * - Input: "double\\\\n" (source with \\n) -> Output: "double\\n" (literal \n text)
 * 
 * @param input The string to convert (the string content as it appears in source)
 * @param original The original string (to detect escape style from the source)
 */
function parseEscapeSequences(input: string, original?: string): string {
	if (!input.includes('\\')) {
		return input;
	}
	
	// Build a map of escape styles for each special character sequence in the original string
	const escapeMap = original ? buildEscapeStyleMap(original) : {};
	
	// If no escapeMap provided, fallback: treat all as single-escaped
	if (!original) {
		return input
			.replace(/\\n/g, '\n')
			.replace(/\\t/g, '\t')
			.replace(/\\r/g, '\r')
			.replace(/\\"/g, '"')
			.replace(/\\'/g, "'")
			.replace(/\\\\/g, '\\')
			.replace(/\\\//g, '/');
	}

	// For each supported escape sequence, replace according to the escapeMap
	let result = input;
	
	// Process in specific order to avoid conflicts
	// Handle newlines
	const nlStyle = escapeMap['\n'];
	if (nlStyle === 'double-escaped') {
		result = result.replace(/\\\\n/g, '\\n');
	} else if (nlStyle === 'single-escaped') {
		result = result.replace(/\\n/g, '\n');
	}
	
	// Handle carriage returns
	const crStyle = escapeMap['\r'];
	if (crStyle === 'double-escaped') {
		result = result.replace(/\\\\r/g, '\\r');
	} else if (crStyle === 'single-escaped') {
		result = result.replace(/\\r/g, '\r');
	}
	
	// Handle tabs
	const tabStyle = escapeMap['\t'];
	if (tabStyle === 'double-escaped') {
		result = result.replace(/\\\\t/g, '\\t');
	} else if (tabStyle === 'single-escaped') {
		result = result.replace(/\\t/g, '\t');
	}
	
	// Handle slashes
	const slashStyle = escapeMap['/'];
	if (slashStyle === 'double-escaped') {
		result = result.replace(/\\\\\//g, '\\/');
	} else if (slashStyle === 'single-escaped') {
		result = result.replace(/\\\//g, '/');
	}
	
	// Handle backslashes (must be done carefully to avoid affecting other escapes)
	const backslashStyle = escapeMap['\\'];
	if (backslashStyle === 'double-escaped') {
		// Convert remaining \\\\ to \\ (but we need to be careful about what's left)
		result = result.replace(/\\\\\\\\/g, '\\\\');
	} else if (backslashStyle === 'single-escaped') {
		// Convert remaining \\ to \ (but we need to be careful about what's left)
		result = result.replace(/\\\\/g, '\\');
	}
	
	// Handle quotes
	const quoteStyle = escapeMap['"'];
	if (quoteStyle === 'double-escaped') {
		result = result.replace(/\\\\"/g, '\\"');
	} else if (quoteStyle === 'single-escaped') {
		result = result.replace(/\\"/g, '"');
	}
	
	const singleQuoteStyle = escapeMap["'"];
	if (singleQuoteStyle === 'double-escaped') {
		result = result.replace(/\\\\'/g, "\\'");
	} else if (singleQuoteStyle === 'single-escaped') {
		result = result.replace(/\\'/g, "'");
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
			let escapeStyle: 'single-escaped' | 'double-escaped' = 'single-escaped';
			let escapeMap: Record<string, 'single-escaped' | 'double-escaped'> = {};
			let hoverLine: number | undefined = undefined;
			let hoverCharacter: number | undefined = undefined;
			let sourceDocumentUri: string | undefined = undefined;
			
			if (arg && typeof arg === 'object' && arg.stringContent !== undefined && typeof arg.hoverLine === 'number' && typeof arg.hoverCharacter === 'number') {
				// Called from hover, with explicit mouse position
				originalString = arg.stringContent;
				hoverLine = arg.hoverLine;
				hoverCharacter = arg.hoverCharacter;
				sourceDocumentUri = arg.documentUri; // Capture the source document URI from hover args
				
				// Try to get stringRange - first check if we can use the current active editor
				let sourceDoc: vscode.TextDocument | undefined = undefined;
				if (editor && arg.documentUri && editor.document.uri.toString() === arg.documentUri) {
					sourceDoc = editor.document;
				} else if (arg.documentUri) {
					// If active editor doesn't match, search for the document in all open documents
					sourceDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === arg.documentUri);
				}
				
				if (sourceDoc && typeof hoverLine === 'number' && typeof hoverCharacter === 'number') {
					try {
						const lineText = sourceDoc.lineAt(hoverLine).text;
						// Search for the string occurrence that contains the hover position
						let idx = -1;
						while (true) {
							idx = lineText.indexOf(originalString, idx + 1);
							if (idx === -1) {
								break;
							}
							// Check if hoverCharacter is within this occurrence
							if (hoverCharacter >= idx && hoverCharacter <= idx + originalString.length) {
								stringRange = new vscode.Range(
									new vscode.Position(hoverLine, idx),
									new vscode.Position(hoverLine, idx + originalString.length)
								);
								console.log('[EscapeBuster] Found stringRange from hover:', stringRange);
								break;
							}
						}
						if (!stringRange) {
							console.warn('[EscapeBuster] Could not find string occurrence at hover position');
						}
					} catch (err) {
						console.error('[EscapeBuster] Error finding stringRange:', err);
					}
				} else {
					console.warn('[EscapeBuster] Source document not found for URI:', arg.documentUri);
				}
				
				// Determine escape style - check if it has double-escaped sequences
				escapeStyle = /\\\\[ntr"'\\/]/.test(originalString) ? 'double-escaped' : 'single-escaped';
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
				// Determine escape style - check if it has double-escaped sequences
				escapeStyle = /\\\\[ntr"'\\/]/.test(originalString) ? 'double-escaped' : 'single-escaped';
			} else if (!arg && editor) {
				const position = editor.selection.active;
				const res = isPositionInString(editor.document, position);
				if (res.isInString && res.stringRange) {
					originalString = res.stringContent;
					stringRange = res.stringRange;
					// Determine escape style - check if it has double-escaped sequences
					escapeStyle = /\\\\[ntr"'\\/]/.test(res.stringContent) ? 'double-escaped' : 'single-escaped';
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
			
			// Use sourceDocumentUri if available (from hover), otherwise use the editor's document
			const finalDocumentUri = sourceDocumentUri || editor?.document.uri.toString();
			
			console.log('[EscapeBuster] Setting up edit context:', {
				documentUri: finalDocumentUri,
				stringRange: stringRange ? `${stringRange.start.line}:${stringRange.start.character}-${stringRange.end.line}:${stringRange.end.character}` : 'undefined',
				originalString: originalString.substring(0, 50) + '...',
				hoverLine,
				hoverCharacter
			});
			
			(globalThis as any)._escapeBusterEditContext = {
				originalString,
				stringRange,
				escapeStyle,
				escapeMap,
				documentUri: finalDocumentUri,
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
	// Store the disposable to prevent memory leaks
	const onSaveDisposable = vscode.workspace.onDidSaveTextDocument(async (doc) => {
		const ctx = (globalThis as any)._escapeBusterEditContext;
		console.log('[EscapeBuster] onSaveTextDocument triggered:', doc.uri.fsPath);
		
		if (!ctx || !ctx.tempFilePath) {
			console.log('[EscapeBuster] No context or tempFilePath:', { hasContext: !!ctx, tempFilePath: ctx?.tempFilePath });
			return;
		}
		
		// Use VS Code's URI handling for reliable cross-platform path comparison
		// This automatically handles case-sensitivity based on the file system
		let tempPath = ctx.tempFilePath;
		try {
			// Resolve symlinks to get the real path
			tempPath = fs.realpathSync(tempPath);
		} catch {
			// Use original path if realpath fails
		}
		
		const tempUri = vscode.Uri.file(tempPath);
		const pathsMatch = doc.uri.toString() === tempUri.toString();
		
		console.log('[EscapeBuster] Comparing paths:', { 
			docUri: doc.uri.toString(), 
			tempUri: tempUri.toString(), 
			pathsMatch
		});
		
		if (!pathsMatch) {
			return;
		}
		
		const editedText = doc.getText();
		console.log('[EscapeBuster] Edited text length:', editedText.length);
		// Only update if the edited text is different from the original string
		let stringRange = ctx.stringRange;
		
		console.log('[EscapeBuster] Initial stringRange:', stringRange ? `${stringRange.start.line}:${stringRange.start.character}-${stringRange.end.line}:${stringRange.end.character}` : 'undefined');
		
		// If stringRange is missing, search for the original string in the correct line and character
		if (!stringRange && ctx.documentUri && typeof ctx.originalString === 'string' && typeof ctx.hoverLine === 'number' && typeof ctx.hoverCharacter === 'number') {
			console.log('[EscapeBuster] Attempting to reconstruct stringRange...');
			console.log('[EscapeBuster] Search params:', {
				documentUri: ctx.documentUri,
				hoverLine: ctx.hoverLine,
				hoverCharacter: ctx.hoverCharacter,
				originalStringLength: ctx.originalString.length
			});
			
			// Try to find the document in open documents first, then open it if needed
			let origDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === ctx.documentUri);
			
			if (!origDoc) {
				// Document not open, try to open it
				try {
					const uri = vscode.Uri.parse(ctx.documentUri);
					origDoc = await vscode.workspace.openTextDocument(uri);
					console.log('[EscapeBuster] Opened original document:', uri.toString());
				} catch (err) {
					console.error('[EscapeBuster] Failed to open original document:', err);
				}
			} else {
				console.log('[EscapeBuster] Found original document in open editors');
			}
			
			if (origDoc) {
				const lineText = origDoc.lineAt(ctx.hoverLine).text;
				console.log('[EscapeBuster] Line text:', lineText);
				
				const searchStr = ctx.originalString;
				let idx = -1;
				let foundRange: vscode.Range | undefined = undefined;
				// Search all occurrences in the line
				while (true) {
					idx = lineText.indexOf(searchStr, idx + 1);
					if (idx === -1) {
						break;
					}
					console.log('[EscapeBuster] Found occurrence at index:', idx);
					// If hoverCharacter is within this occurrence, use it
					if (ctx.hoverCharacter >= idx && ctx.hoverCharacter <= idx + searchStr.length) {
						const start = new vscode.Position(ctx.hoverLine, idx);
						const end = new vscode.Position(ctx.hoverLine, idx + searchStr.length);
						foundRange = new vscode.Range(start, end);
						console.log('[EscapeBuster] ✅ Reconstructed stringRange:', foundRange);
						break;
					}
				}
				if (foundRange) {
					stringRange = foundRange;
				} else {
					console.error('[EscapeBuster] ❌ Failed to reconstruct stringRange - no matching occurrence found');
				}
			}
		}
		// Update the original document if we have all required information
		// Always attempt to update when saved, regardless of whether content changed
		console.log('[EscapeBuster] Checking update conditions:', {
			hasEditedText: editedText !== undefined,
			hasDocumentUri: !!ctx.documentUri,
			documentUri: ctx.documentUri,
			hasStringRange: !!stringRange,
			stringRange: stringRange ? `${stringRange.start.line}:${stringRange.start.character}-${stringRange.end.line}:${stringRange.end.character}` : 'undefined',
			hasOriginalString: typeof ctx.originalString === 'string'
		});
		
		if (
			editedText !== undefined &&
			ctx.documentUri &&
			stringRange &&
			typeof ctx.originalString === 'string'
		) {
			// Parse the stored URI string back to a URI object for proper comparison
			const targetUri = vscode.Uri.parse(ctx.documentUri);
			
			// Find the original document using fsPath comparison (more reliable than URI string comparison)
			console.log('[EscapeBuster] Looking for document:', {
				targetUri: targetUri.toString(),
				targetFsPath: targetUri.fsPath
			});
			
			let origDoc = vscode.workspace.textDocuments.find(d => {
				// Compare using fsPath and URI toString() for better compatibility
				const uriMatch = d.uri.toString() === targetUri.toString();
				const fsPathMatch = d.uri.fsPath === targetUri.fsPath;
				return uriMatch || fsPathMatch;
			});
			
			if (!origDoc) {
				// Try opening the document if not found
				try {
					origDoc = await vscode.workspace.openTextDocument(targetUri);
					console.log('[EscapeBuster] ✅ Opened original document');
				} catch (err) {
					console.error('[EscapeBuster] ❌ Failed to open original document:', err);
				}
			} else {
				console.log('[EscapeBuster] ✅ Found original document in open editors');
			}
			
			if (origDoc) {
				console.log('[EscapeBuster] Found original document, showing editor...');
				// Show the document in an editor
				const origEditor = await vscode.window.showTextDocument(origDoc, { preview: false, preserveFocus: true });
				// Convert the edited text back to escaped format and replace
				const escapedString = multiLineToEscapedString(editedText, ctx.escapeStyle, ctx.escapeMap, ctx.originalString);
				console.log('[EscapeBuster] Escaped string:', escapedString.substring(0, 100) + '...');
				console.log('[EscapeBuster] Replacing at range:', stringRange);
				
				await origEditor.edit(editBuilder => {
					editBuilder.replace(stringRange, escapedString);
				});
				console.log('[EscapeBuster] ✅ Successfully updated original document');
			} else {
				console.error('[EscapeBuster] ❌ Could not find the original document to update');
				vscode.window.showWarningMessage('Escape Buster: Could not find the original document to update.');
			}
		} else {
			console.error('[EscapeBuster] ❌ Missing required information for update');
			if (!stringRange) {
				vscode.window.showWarningMessage('Escape Buster: Could not determine string range for replacement.');
			} else if (!ctx.documentUri) {
				vscode.window.showWarningMessage('Escape Buster: Missing document URI for replacement.');
			}
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
	
	// Add the save listener to subscriptions to prevent memory leaks
	context.subscriptions.push(onSaveDisposable);

	// On tab close, delete the temp file and clear context. Only update original if file was saved.
	// Store the disposable to prevent memory leaks
	const onChangeEditorsDisposable = vscode.window.onDidChangeVisibleTextEditors(async (editors) => {
		const ctx = (globalThis as any)._escapeBusterEditContext;
		if (!ctx || !ctx.tempFilePath) {
			return;
		}
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
	
	// Add the editor change listener to subscriptions to prevent memory leaks
	context.subscriptions.push(onChangeEditorsDisposable);

	/**
	 * Convert multi-line text back to an escaped string for insertion into source code.
	 * This is the inverse operation of parseEscapeSequences.
	 * 
	 * Examples:
	 * - Input: "hello\nworld" (actual newline), style: 'single-escaped' -> Output: "hello\\nworld"
	 * - Input: "url/path" (actual slash), style: 'single-escaped' -> Output: "url\\/path"
	 * - Input: "text\\n" (literal \n), style: 'double-escaped' -> Output: "text\\\\n"
	 * 
	 * @param text The actual text content (with real newlines, tabs, etc.)
	 * @param style Default escape style to use
	 * @param escapeMap Per-character escape style overrides
	 * @param original The original source string (unused in current implementation)
	 */
	function multiLineToEscapedString(text: string, style: 'single-escaped' | 'double-escaped', escapeMap?: Record<string, 'single-escaped' | 'double-escaped'>, original?: string): string {
		// Process the string character by character, using escapeMap for per-character style
		let result = '';
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			let charStyle = style;
			if (escapeMap && escapeMap[ch]) {
				charStyle = escapeMap[ch];
			}
			switch (ch) {
				case '\n':
					// single-escaped: \n, double-escaped: \\n
					result += charStyle === 'double-escaped' ? '\\\\n' : '\\n';
					break;
				case '\r':
					result += charStyle === 'double-escaped' ? '\\\\r' : '\\r';
					break;
				case '\t':
					result += charStyle === 'double-escaped' ? '\\\\t' : '\\t';
					break;
				case '"':
					result += charStyle === 'double-escaped' ? '\\\\"' : '\\"';
					break;
				case "'":
					result += charStyle === 'double-escaped' ? "\\\\'" : "\\'";
					break;
				case '\\':
					result += charStyle === 'double-escaped' ? '\\\\\\\\' : '\\\\';
					break;
				case '/':
					result += charStyle === 'double-escaped' ? '\\\\/' : '\\/';
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
				// Pass stringContent, line, character, and documentUri to the command as an object
				// documentUri is needed to verify the operation is on the correct source file
				const hoverArgs = {
					stringContent,
					hoverLine: position.line,
					hoverCharacter: position.character,
					documentUri: document.uri.toString()
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
