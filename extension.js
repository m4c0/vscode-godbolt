const vscode = require('vscode');
const http = require('http');
const https = require('https');
const url = require('url');

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

function download(path, opts, post) {
	let config = vscode.workspace.getConfiguration('compilerExplorer');
	let godboltUrl = new url.URL(path, config.get('baseUrl'));
	return new Promise((c, e) => {
		var content = '';
		let client = (godboltUrl.protocol === 'https:') ? https : http;
		let req = client.request(godboltUrl, {
			headers: {
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			},
			...opts
		}, resp => {
			if (resp.statusCode != 200) {
				e("Invalid combination of parameters");
				return;
			}
			resp
				.on('data', data => { content += data.toString() })
				.on('end', () => { c(JSON.parse(content)) })
		});
		req.on('error', err => { e(err.message) });
		if (post) req.write(JSON.stringify(post))
		req.end();
	})
}

function selectCompiler() {
	let config = vscode.workspace.getConfiguration('compilerExplorer');
	let current = config.get('compiler');
	return vscode.window.showQuickPick(download('/api/compilers/c++').then(list => {
		return list.map(item => {
			return {
				id: item.id,
				label: item.name,
				picked: item.id === current,
			};
		}).sort((a, b) => a.label.localeCompare(b.label));
	}), {
		canPickMany: false
	}).then(x => {
		if (!x) return;

		let all = config.inspect('compiler');
		// This smells like we are doing something wrong here...
		if (all.workspaceFolderValue) {
			config.update('compiler', x.id, vscode.ConfigurationTarget.WorkspaceFolder);
		} else if (all.workspaceValue) {
			config.update('compiler', x.id, vscode.ConfigurationTarget.Workspace);
		} else {
			config.update('compiler', x.id, vscode.ConfigurationTarget.Global);
		}
	});
}

module.exports = {
	activate: ({ subscriptions }) => {
		let c = new Compiler();
		let o = vscode.window.createOutputChannel("Compiler Explorer");

		vscode.workspace.onDidCloseTextDocument(c.onDidCloseTextDocument, c);

		subscriptions.push(c);
		subscriptions.push(o);
		subscriptions.push(vscode.commands.registerCommand('extension.compileInCompilerExplorer', c.compile, c));
		subscriptions.push(vscode.commands.registerCommand('extension.selectCompiler', selectCompiler));
		subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('godbolt', {
			onDidChange: c.eventEmitter.event,
			provideTextDocumentContent: async (uri) => {
				o.clear();

				let config = vscode.workspace.getConfiguration('compilerExplorer');
				
				let doc = await vscode.workspace.openTextDocument(uri.path.replace(/.asm$/, ''));
				let resp = await download('/api/compiler/' + config.get('compiler') + '/compile', {
					method: 'POST'
				}, {
					source: doc.getText(),
					options: {
						userArguments: config.get('flags'),
						filters: {
							labels: true,
							intel: true,
							directives: true,
							demangle: true,
							comments: true,
						}
					}
				}).catch(msg => vscode.window.showErrorMessage(msg));

				resp.stderr.forEach(x => {
					// thanks Qix, http://stackoverflow.com/questions/25245716/remove-all-ansi-colors-styles-from-strings
					o.appendLine(x.text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''))
				});
				if (resp.stderr.length > 0) o.show(true);

				return (
					"# Compilation provided by Compiler Explorer at " + config.get('baseUrl') + "\n" + 
					"# Options: Compiler = " + config.get('compiler') + "\n" +
					resp.asm.map(x => x.text).join('\n')
				);
			}
		}));
	},
	//deactivate: () => {}
}
