const vscode = require('vscode');
const https = require('https');

class Compiler extends vscode.Disposable {
	constructor() {
		super();

		this.eventEmitter = new vscode.EventEmitter();
		this.documents = {};
	}

	dispose() {
		this.eventEmitter.dispose();
		Object.keys(this.documents).forEach(val => val.dispose());
	}

	async compile({ path }) {
		let uri = vscode.Uri.parse('godbolt:' + path + '.asm');
		if (!this.documents[path]) {
			let doc = await vscode.workspace.openTextDocument(uri);
			this.documents[path] = doc;
		} else {
			this.eventEmitter.fire(uri);
		}

		await vscode.window.showTextDocument(this.documents[path], {
			preserveFocus: true,
			preview: true,
			viewColumn: vscode.ViewColumn.Beside
		});
	}

	onDidCloseTextDocument(doc) {
		delete this.editors[doc.path];
	}
}

function download(opts, post) {
	return new Promise((c, e) => {
		var content = '';
		let req = https.request({
			headers: {
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			},
			...opts
		}, resp => {
			resp
				.on('data', data => { content += data.toString() })
				.on('end', () => { c(JSON.parse(content)) })
		});
		req.on('error', err => { e(err.message) });
		if (post) req.write(JSON.stringify(post))
		req.end();
	})
}

module.exports = {
	activate: ({ subscriptions }) => {
		let c = new Compiler();
		let o = vscode.window.createOutputChannel("Compiler Explorer");

		vscode.workspace.onDidCloseTextDocument(c.onDidCloseTextDocument, c);

		subscriptions.push(c);
		subscriptions.push(o);
		subscriptions.push(vscode.commands.registerCommand('extension.compileInCompilerExplorer', c.compile, c));
		subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('godbolt', {
			onDidChange: c.eventEmitter.event,
			provideTextDocumentContent: async (uri) => {
				o.clear();

				let doc = await vscode.workspace.openTextDocument(uri.path.replace(/.asm$/, ''));
				let resp = await download({
					hostname: 'godbolt.org',
					port: 443,
					path: '/api/compiler/g83/compile',
					method: 'POST'
				}, {
					source: doc.getText(),
					options: {
						userArguments: '-O2 -std=c++17',
						filters: {
							labels: true,
							intel: true,
							directives: true,
							demangle: true,
							comments: true,
						}
					}
				});

				resp.stderr.forEach(x => {
					// thanks Qix, http://stackoverflow.com/questions/25245716/remove-all-ansi-colors-styles-from-strings
					o.appendLine(x.text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''))
				});
				if (resp.stderr.length > 0) o.show(true);

				return "# Compilation provided by Compiler Explorer at godbolt.org\n" + resp.asm.map(x => x.text).join('\n');
			}
		}));
	},
	//deactivate: () => {}
}
