import * as vscode from 'vscode';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';

let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
    // Create a diagnostic collection for our linter
    diagnosticCollection = vscode.languages.createDiagnosticCollection('alpine-csp-linter');
    context.subscriptions.push(diagnosticCollection);

    let disposable = vscode.languages.registerCodeActionsProvider(
        { scheme: 'file', language: 'html' },
        new AlpineCSPLinter(),
        {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
        }
    );

    context.subscriptions.push(disposable);

    // Register a command to manually trigger the linter
    let command = vscode.commands.registerCommand('extension.lintAlpineCSP', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const document = editor.document;
            const diagnostics = lintDocument(document);
            diagnosticCollection.set(document.uri, diagnostics);
        }
    });

    context.subscriptions.push(command);

    // Run the linter on the active editor when the extension is activated
    if (vscode.window.activeTextEditor) {
        const diagnostics = lintDocument(vscode.window.activeTextEditor.document);
        diagnosticCollection.set(vscode.window.activeTextEditor.document.uri, diagnostics);
    }

    // Run the linter whenever a text document is opened or changed
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const diagnostics = lintDocument(event.document);
            diagnosticCollection.set(event.document.uri, diagnostics);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => {
            const diagnostics = lintDocument(document);
            diagnosticCollection.set(document.uri, diagnostics);
        })
    );
}

class AlpineCSPLinter implements vscode.CodeActionProvider {
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.CodeAction[] {
        const diagnostics = lintDocument(document);
        diagnosticCollection.set(document.uri, diagnostics);
        return [];
    }
}

function lintDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
	const text = document.getText();
	const diagnostics: vscode.Diagnostic[] = [];

	// Remove HTML comments
	const textWithoutComments = text.replace(/<!--[\s\S]*?-->/g, '');

	// Check for inline x-data
	const inlineXDataRegex = /x-data="\s*{[^}]*}"/g;
	let match;
	while ((match = inlineXDataRegex.exec(textWithoutComments)) !== null) {
			const range = new vscode.Range(
					document.positionAt(match.index),
					document.positionAt(match.index + match[0].length)
			);
			diagnostics.push(new vscode.Diagnostic(
					range,
					'Inline x-data is not allowed in CSP-friendly mode. Use Alpine.data() instead.',
					vscode.DiagnosticSeverity.Error
			));
	}

	// Check other Alpine directives, excluding x-for
	const directiveRegex = /(?:x-(?!for)[\w-]+|@[\w-]+)="([^"]*)"/g;
	while ((match = directiveRegex.exec(textWithoutComments)) !== null) {
			const value = match[1].trim();
			const startPos = document.positionAt(match.index);
			const endPos = document.positionAt(match.index + match[0].length);
			const range = new vscode.Range(startPos, endPos);

			// Skip empty strings
			if (value === '') {
					continue;
			}

			// Check if the value is a simple property access or method call
			if (/^[\w.]+$/.test(value)) {
					// This is a valid simple property access or method call without arguments
					continue;
			}

			try {
					// Remove JS comments before parsing
					const valueWithoutComments = value.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
					const ast = parser.parse(valueWithoutComments, { sourceType: 'module' });
					let hasViolation = false;

					traverse(ast, {
							enter(path) {
									if (
											path.isMemberExpression() && !path.node.computed ||
											path.isIdentifier() ||
											path.isStringLiteral() ||
											path.isNumericLiteral() ||
											path.isTemplateLiteral() && path.node.expressions.length === 0
									) {
											// These are allowed
									} else if (
											path.isCallExpression() &&
											path.node.callee.type === 'Identifier' &&
											path.node.arguments.length === 0
									) {
											// Allow method calls without arguments
									} else {
											hasViolation = true;
											path.stop(); // Stop traversing this branch
									}
							}
					});

					if (hasViolation) {
							const diagnostic = new vscode.Diagnostic(
									range,
`Potential CSP violation: Only dot notation, static access, and method calls without arguments are allowed.

Read more: https://alpinejs.dev/advanced/csp`,
									vscode.DiagnosticSeverity.Error
							);
							diagnostics.push(diagnostic);
					}
			} catch (error) {
					// Parsing error, likely due to incomplete expression. Ignore.
			}
	}

	return diagnostics;
}


export function deactivate() {
    if (diagnosticCollection) {
        diagnosticCollection.clear();
        diagnosticCollection.dispose();
    }
}