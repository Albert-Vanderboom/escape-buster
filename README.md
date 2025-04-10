# EscapeBuster

EscapeBuster is a VS Code extension that provides a convenient way to preview strings containing escape sequences like `\n`, `\t`, and `\r`. It's especially useful when working with code or formatted data stored as strings in JSON files and other formats.

## Features

- **Preview on Hover**: Automatically previews strings containing escape sequences when you hover over them
- **Scrollable Preview**: Easily navigate through large previews with scrollable panels
- **Code Detection**: Intelligent detection of code in strings with appropriate syntax highlighting
- **Configurable File Types**: Customize which file types the extension should work with
- **User-Friendly Interface**: Clean, intuitive design with easy navigation controls

## Installation

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "EscapeBuster"
4. Click Install

Or install directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=your-publisher.escape-buster).

## Usage

1. Open a file containing strings with escape sequences (e.g., a JSON file)
2. Hover over a string that contains escape sequences like `\n`, `\t`, or `\r`
3. A preview will appear showing the formatted content with escape sequences interpreted
4. For large content, use the scroll functionality to navigate
5. Pin the preview to keep it visible while working on other parts of your code

## Configuration

EscapeBuster can be configured through the VS Code settings:

- `escapeBuster.enabledFileTypes`: Array of file extensions where the extension should be active (default: `["json"]`)
- `escapeBuster.hoverDelay`: Delay in milliseconds before showing the preview (default: `300`)
- `escapeBuster.enableAutoPreview`: Enable/disable automatic preview on hover (default: `true`)
- `escapeBuster.defaultPreviewHeight`: Default height for the preview panel (default: `300`)

Example configuration in `settings.json`:

```json
{
  "escapeBuster.enabledFileTypes": ["json", "js", "ts"],
  "escapeBuster.hoverDelay": 500,
  "escapeBuster.enableAutoPreview": true,
  "escapeBuster.defaultPreviewHeight": 400
}
```

## Requirements

- VS Code 1.60.0 or higher

## Known Issues

- Performance may be affected when previewing very large strings
- Code language detection may not be 100% accurate for all content types

## Release Notes

### 1.0.0

Initial release of EscapeBuster:

- Preview strings with escape sequences on hover
- Scrollable preview panel
- Code detection and syntax highlighting
- Configurable file type support

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
