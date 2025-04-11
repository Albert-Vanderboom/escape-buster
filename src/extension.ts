// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
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
 * Parse escape sequences in a string
 */
function parseEscapeSequences(input: string): string {
	// Check if the string contains any escape sequences
	if (!input.includes('\\')) {
		return input;
	}

	// Using negative lookbehind to avoid replacing escaped backslashes
	return input
		.replace(/(?<!\\)\\n/g, '\n')
		.replace(/(?<!\\)\\t/g, '\t')
		.replace(/(?<!\\)\\r/g, '\r')
		.replace(/(?<!\\)\\"/g, '"')
		.replace(/(?<!\\)\\'/g, "'")
		// After handling all escape sequences, replace double backslashes with single ones
		.replace(/\\\\/g, '\\');
}

/**
 * Check if a string contains escape sequences that we support
 */
function containsEscapeSequences(input: string): boolean {
	// Check if there are any escape sequences that are not escaped backslashes
	// Match any \ that is not preceded by another \, and is followed by one of our supported escape chars
	return /(?<!\\)\\[ntr"']/.test(input);
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
			'html', 'xml', 'toml', 'yaml','css', 
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
	console.log('Extension "escape-buster" is now active');
	
	// Add debug output for activation
	vscode.window.showInformationMessage('EscapeBuster extension is now active!');

	// Register the hover provider for each supported language
	const supportedLanguages = ['json', 'javascript', 'typescript', 'c', 'cpp'];
	
	const hoverProvider = vscode.languages.registerHoverProvider(
		supportedLanguages,
		{
			provideHover(document, position, token) {
				// Check if the file type is enabled in user settings
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
				const parsedContent = parseEscapeSequences(stringContent);
				
				// Detect language for syntax highlighting
				const language = detectCodeLanguage(parsedContent);
				
				// Create a markdown string for the hover with link at the top
				const markdownContent = new vscode.MarkdownString();
				markdownContent.appendMarkdown('### Escaped String Preview');
				markdownContent.appendMarkdown('\n\n[Open in Preview Panel](command:escape-buster.previewEscapedString?' + 
					encodeURIComponent(JSON.stringify([stringContent])) + ')\n\n');
				
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
			const parsedContent = parseEscapeSequences(stringContent);
			// Use the same language detection as the hover preview
			const language = detectCodeLanguage(parsedContent);
			// Create a title that includes the language if detected
			const title = language ? `Escaped String Preview (${language})` : 'Escaped String Preview';
			EscapePreviewPanel.createOrShow(context.extensionUri, parsedContent, title);
		}
	});

	context.subscriptions.push(hoverProvider);
	context.subscriptions.push(previewCommand);
}

/**
 * This method is called when your extension is deactivated
 */
export function deactivate() {
	// Clean-up code if needed
}
