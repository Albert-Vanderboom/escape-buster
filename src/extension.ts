// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

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
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
			}
		);

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
		webview.html = this._getHtmlForWebview(webview, content);
	}

	private _getHtmlForWebview(webview: vscode.Webview, content: string): string {
		// Try to detect if the content is code
		const isCode = detectCodeLanguage(content);
		const languageClass = isCode ? `language-${isCode}` : '';
		
		// Escape content for HTML rendering
		const escapedContent = escapeHtml(content);

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Escaped String Preview</title>
			<style>
				body {
					font-family: var(--vscode-editor-font-family);
					background-color: var(--vscode-editor-background);
					color: var(--vscode-editor-foreground);
					padding: 10px;
					overflow: auto;
				}
				.container {
					max-height: 100%;
					overflow: auto;
					white-space: pre-wrap;
					word-wrap: break-word;
				}
				.code {
					font-family: var(--vscode-editor-font-family);
					font-size: var(--vscode-editor-font-size);
					line-height: 1.5;
				}
				.header {
					padding-bottom: 10px;
					border-bottom: 1px solid var(--vscode-panel-border);
					margin-bottom: 10px;
					display: flex;
					justify-content: space-between;
					align-items: center;
				}
				.btn {
					background-color: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
					border: none;
					padding: 5px 10px;
					cursor: pointer;
					border-radius: 2px;
				}
				.btn:hover {
					background-color: var(--vscode-button-hoverBackground);
				}
			</style>
		</head>
		<body>
			<div class="header">
				<h3>Escaped String Preview</h3>
				<button class="btn" id="copyBtn">Copy to Clipboard</button>
			</div>
			<div class="container">
				<pre class="code ${languageClass}">${escapedContent}</pre>
			</div>
			<script>
				const copyBtn = document.getElementById('copyBtn');
				const content = document.querySelector('.code');
				
				copyBtn.addEventListener('click', () => {
					const range = document.createRange();
					range.selectNode(content);
					const selection = window.getSelection();
					selection.removeAllRanges();
					selection.addRange(range);
					document.execCommand('copy');
					selection.removeAllRanges();
					
					// Signal back to the extension
					const vscode = acquireVsCodeApi();
					vscode.postMessage({
						command: 'copied'
					});
				});
			</script>
		</body>
		</html>`;
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

	// Process the escape sequences
	return input.replace(/\\n/g, '\n')
				.replace(/\\t/g, '\t')
				.replace(/\\r/g, '\r');
}

/**
 * Check if a string contains escape sequences that we support
 */
function containsEscapeSequences(input: string): boolean {
	return /\\[ntr]/.test(input);
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

/**
 * Simple code language detection based on content
 */
function detectCodeLanguage(content: string): string | null {
	// Check for common language patterns
	if (/^\s*<\!DOCTYPE html>|<html|<body|<head/.test(content)) {
		return 'html';
	}
	
	if (/^\s*import\s+|export\s+|function\s+\w+\s*\(|const\s+\w+\s*=|let\s+\w+\s*=|class\s+\w+/.test(content)) {
		return 'javascript';
	}
	
	if (/^\s*{[\s\n]*"/.test(content) || /^\s*\[[\s\n]*{/.test(content)) {
		return 'json';
	}
	
	if (/^\s*def\s+\w+\s*\(|import\s+\w+|class\s+\w+:/.test(content)) {
		return 'python';
	}
	
	if (/^\s*<\?php/.test(content)) {
		return 'php';
	}
	
	if (/^\s*<\?xml/.test(content)) {
		return 'xml';
	}
	
	if (/^\s*(public|private|protected)\s+class\s+/.test(content)) {
		return 'java';
	}
	
	// If no patterns match, return null
	return null;
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
	const supportedLanguages = ['json', 'javascript', 'typescript'];
	
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
				
				// Create a markdown string for the hover
				const markdownContent = new vscode.MarkdownString();
				markdownContent.appendMarkdown('### Escaped String Preview\n\n');
				markdownContent.appendCodeblock(parsedContent);
				markdownContent.appendMarkdown('\n\n[Open in Preview Panel](command:escape-buster.previewEscapedString?' + 
											   encodeURIComponent(JSON.stringify([stringContent])) + ')');
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
			EscapePreviewPanel.createOrShow(context.extensionUri, parsedContent, 'Escaped String Preview');
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
