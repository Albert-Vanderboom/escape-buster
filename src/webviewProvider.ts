import * as vscode from 'vscode';
import hljs from 'highlight.js';

/**
 * Generate HTML for the preview panel with theme-aware syntax highlighting
 */
export function generatePreviewHtml(content: string, language: string | null): string {
    // For WebView, we need to decode any HTML entities before displaying
    const decodedContent = decodeHtmlEntities(content);
    const languageClass = language ? `language-${language}` : '';
    
    // Apply syntax highlighting
    let displayContent = decodedContent;
    if (language) {
        try {
            // Apply syntax highlighting
            displayContent = hljs.highlight(decodedContent, { language }).value;
            
            // Special handling for C/C++ preprocessor directives
            if (language === 'c' || language === 'cpp') {
                // Make preprocessor directives (#include, etc.) match VSCode style
                displayContent = processPreprocessorDirectives(displayContent);
            }
        } catch (error) {
            console.error('Syntax highlighting error:', error);
        }
    } else {
        // If no language detected, escape HTML entities
        displayContent = escapeHtml(decodedContent);
    }
    
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Escaped String Preview</title>
        <style>
            ${getBaseStyles()}
            ${getSyntaxHighlightStyles()}
        </style>
    </head>
    <body>
        <div class="header">
            <h3>Escaped String Preview${language ? ` (${language})` : ''}</h3>
            <button class="btn" id="copyBtn">Copy to Clipboard</button>
        </div>
        <div class="container">
            <pre class="code ${languageClass}">${displayContent}</pre>
            ${language ? `<div class="language-label">Language: ${language}</div>` : ''}
        </div>
        <script>
            ${getJavaScript()}
        </script>
    </body>
    </html>`;
}

/**
 * Process C/C++ preprocessor directives to match VSCode style
 */
function processPreprocessorDirectives(content: string): string {
    // First handle any hljs-meta spans that contain preprocessor directives
    let result = content.replace(
        /(<span class="hljs-meta"[^>]*>)(#\w+)(<\/span>)/g,
        '<span class="hljs-preprocessor">$2</span>'
    );
    
    // Also handle cases where # might be separate from the directive name
    result = result.replace(
        /#(include|define|ifdef|ifndef|endif|else|elif|pragma|if|undef)/g,
        '<span class="hljs-preprocessor">#$1</span>'
    );
    
    // Color include brackets and paths in #include statements
    result = result.replace(
        /(<span class="hljs-preprocessor">#include<\/span>)(\s*)(&lt;)([^&]*)(&gt;)/g,
        '$1$2<span class="hljs-string">$3$4$5</span>'
    );
    
    // Color include paths in quotes
    result = result.replace(
        /(<span class="hljs-preprocessor">#include<\/span>)(\s*)(")(.*?)(")/g,
        '$1$2<span class="hljs-string">$3$4$5</span>'
    );
    
    return result;
}

/**
 * Get base styles for the webview
 */
function getBaseStyles(): string {
    return `
        :root {
            --container-padding: 1rem;
        }
        html, body {
            height: 100%;
            width: 100%;
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-editor-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: var(--container-padding);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            min-height: 100vh;
        }
        .container {
            flex: 1;
            overflow: auto;
            white-space: pre-wrap;
            word-wrap: break-word;
            tab-size: 4;
            -moz-tab-size: 4;
            -o-tab-size: 4;
            width: 100%;
            box-sizing: border-box;
            min-height: 70vh;
        }
        /* Use VSCode's code block styling to match hover preview */
        .code {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.5;
            tab-size: 4;
            -moz-tab-size: 4;
            -o-tab-size: 4;
            white-space: pre;
            width: 100%;
            
            /* Match VSCode markdown codeblock styling */
            background-color: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textCodeBlock-foreground);
            padding: 1em;
            overflow: auto;
            border-radius: 3px;
        }
        .header {
            padding-bottom: var(--container-padding);
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: var(--container-padding);
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
            box-sizing: border-box;
        }
        .btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 0.5rem 1rem;
            cursor: pointer;
            border-radius: 2px;
        }
        .btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        /* Language label */
        .language-label {
            font-size: 0.8em;
            color: var(--vscode-descriptionForeground);
            margin-top: 0.5em;
            text-align: right;
        }
    `;
}

/**
 * Get syntax highlighting styles that work in both light and dark themes
 */
function getSyntaxHighlightStyles(): string {
    return `
        /* Syntax highlighting colors that work in both light and dark themes */
        /* Dark theme colors with increased contrast for light themes */
        .vscode-light .hljs-keyword, 
        .vscode-high-contrast-light .hljs-keyword { color: #0000ff; }
        .vscode-dark .hljs-keyword, 
        .vscode-high-contrast-dark .hljs-keyword { color: #569cd6; }
        
        .vscode-light .hljs-string, 
        .vscode-high-contrast-light .hljs-string { color: #a31515; }
        .vscode-dark .hljs-string, 
        .vscode-high-contrast-dark .hljs-string { color: #ce9178; }
        
        .vscode-light .hljs-comment, 
        .vscode-high-contrast-light .hljs-comment { color: #008000; }
        .vscode-dark .hljs-comment, 
        .vscode-high-contrast-dark .hljs-comment { color: #6A9955; }
        
        .vscode-light .hljs-function, 
        .vscode-high-contrast-light .hljs-function { color: #795E26; }
        .vscode-dark .hljs-function, 
        .vscode-high-contrast-dark .hljs-function { color: #dcdcaa; }
        
        .vscode-light .hljs-number, 
        .vscode-high-contrast-light .hljs-number { color: #098658; }
        .vscode-dark .hljs-number, 
        .vscode-high-contrast-dark .hljs-number { color: #b5cea8; }
        
        .vscode-light .hljs-class, 
        .vscode-high-contrast-light .hljs-class { color: #267f99; }
        .vscode-dark .hljs-class, 
        .vscode-high-contrast-dark .hljs-class { color: #4ec9b0; }
        
        .vscode-light .hljs-title, 
        .vscode-high-contrast-light .hljs-title { color: #795E26; }
        .vscode-dark .hljs-title, 
        .vscode-high-contrast-dark .hljs-title { color: #dcdcaa; }
        
        .vscode-light .hljs-title.function__, 
        .vscode-high-contrast-light .hljs-title.function__ { color: #795E26; }
        .vscode-dark .hljs-title.function__, 
        .vscode-high-contrast-dark .hljs-title.function__ { color: #dcdcaa; }
        
        .vscode-light .hljs-params, 
        .vscode-high-contrast-light .hljs-params { color: #001080; }
        .vscode-dark .hljs-params, 
        .vscode-high-contrast-dark .hljs-params { color: #9cdcfe; }
        
        .vscode-light .hljs-built_in, 
        .vscode-high-contrast-light .hljs-built_in { color: #267f99; }
        .vscode-dark .hljs-built_in, 
        .vscode-high-contrast-dark .hljs-built_in { color: #4ec9b0; }
        
        .vscode-light .hljs-literal, 
        .vscode-high-contrast-light .hljs-literal { color: #0000ff; }
        .vscode-dark .hljs-literal, 
        .vscode-high-contrast-dark .hljs-literal { color: #569cd6; }
        
        .vscode-light .hljs-type, 
        .vscode-high-contrast-light .hljs-type { color: #267f99; }
        .vscode-dark .hljs-type, 
        .vscode-high-contrast-dark .hljs-type { color: #4ec9b0; }
        
        .vscode-light .hljs-variable, 
        .vscode-high-contrast-light .hljs-variable { color: #001080; }
        .vscode-dark .hljs-variable, 
        .vscode-high-contrast-dark .hljs-variable { color: #9cdcfe; }
        
        .vscode-light .hljs-attr, 
        .vscode-high-contrast-light .hljs-attr { color: #001080; }
        .vscode-dark .hljs-attr, 
        .vscode-high-contrast-dark .hljs-attr { color: #9cdcfe; }
        
        .vscode-light .hljs-preprocessor, 
        .vscode-high-contrast-light .hljs-preprocessor { color: #0000ff; }
        .vscode-dark .hljs-preprocessor, 
        .vscode-high-contrast-dark .hljs-preprocessor { color: #569cd6; }
        
        .vscode-light .hljs-meta, 
        .vscode-high-contrast-light .hljs-meta { color: #0000ff; }
        .vscode-dark .hljs-meta, 
        .vscode-high-contrast-dark .hljs-meta { color: #569cd6; }
    `;
}

/**
 * Get JavaScript code for the webview
 */
function getJavaScript(): string {
    return `
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
    `;
}

/**
 * Decode HTML entities to their actual characters
 */
export function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * Escape HTML special characters for display, but preserve existing entities
 */
export function escapeHtml(text: string): string {
    // Only escape actual characters that need escaping, not existing HTML entities
    return text
        .replace(/&(?!amp;|lt;|gt;|quot;|#039;)/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
} 