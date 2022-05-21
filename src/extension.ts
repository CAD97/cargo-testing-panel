import * as vscode from 'vscode';
import { Cargo, CompilationArtifact } from './toolchain';
import { log, outputChannel } from './util';

type TargetKind = 'lib' | 'bin' | 'example' | 'test' | 'bench';

interface TestTarget {
	package: string;
	kind: TargetKind;
	name: string;
}

class CargoTestItem {
	constructor(readonly target: TestTarget, readonly name: string[]) { }
}

let testData!: WeakMap<vscode.TestItem, CargoTestItem>;
let testDataRev!: Map<string, vscode.TestItem>;
let controller!: vscode.TestController;
let runProfile!: vscode.TestRunProfile;

async function resolveHandler(item: vscode.TestItem | undefined) {
	const artifacts = await new Cargo(outputChannel).artifactsFromArgs(["test", "-q", "--all-targets", "--workspace"]);
	const artifactMap = artifacts.reduce((map, obj) => {
		const testTarget = { name: obj.name, kind: obj.kind as TargetKind, package: obj.packageName };
		if (testTarget.kind === 'bin') {
			obj.packageName += ' (bin)';
		}
		const testItem = controller.createTestItem(obj.packageName, obj.packageName);
		controller.items.add(testItem);
		testData.set(testItem, new CargoTestItem(testTarget, []));
		map.set(obj.fileName, [testTarget, testItem]);
		return map;
	}, new Map<string, [TestTarget, vscode.TestItem]>());

	var currentTestTarget: TestTarget | undefined;
	var currentTestItem: vscode.TestItem | undefined;
	await Cargo.runUnified(
		["test", "--all-targets", "--workspace", "--", "--list"],
		(line) => {
			let rePath = /Running .*? \((.*?)\)/.exec(line);
			if (rePath) {
				const artifact = artifactMap.get(rePath[1]);
				if (artifact) {
					currentTestTarget = artifact[0];
					currentTestItem = artifact[1];
				} else {
					log.error(`test path (${rePath[1]}) in test --list but not test --no-run?`);
				}
			}

			const reTest = /\s*(\w.*): test/.exec(line);
			if (currentTestTarget && currentTestItem && reTest) {
				const testName = reTest[1].split("::");
				const testLastName = testName.at(-1)!;
				var itemPointer = currentTestItem;
				for (const part of testName) {
					var childItem = itemPointer.children.get(part);
					if (!childItem) {
						childItem = controller.createTestItem(part, part);
						itemPointer.children.add(childItem);
						testData.set(childItem, new CargoTestItem(currentTestTarget, testName.slice(0, testName.indexOf(part) + 1)));
					}
					if (childItem) {
						itemPointer = childItem;
					}
				}
				testDataRev.set([currentTestTarget.package].concat(testName).join("::"), itemPointer);
			}
		},
	);
};

async function runHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
	const run = controller.createTestRun(request);
	const queue: vscode.TestItem[] = [];

	const include = new Map<string, { runArgs: string[], filters: Set<string[]>, report: vscode.TestItem}>();
	const exclude = new Map<string, Set<string[]>>();

	// eslint-disable-next-line curly
	if (request.exclude) for (const testItem of request.exclude) {
		const testInfo = testData.get(testItem)!;
		if (!(testInfo.target.package in exclude)) {
			exclude.set(testInfo.target.package, new Set());
		}
		exclude.get(testInfo.target.package)!.add(testInfo.name);
	}

	(request.include ? request.include : controller.items).forEach(testItem => {
		const testInfo = testData.get(testItem)!;
		if (!(testInfo.target.package in include)) {
			var runArgs = ["test", "-q", "--package", testInfo.target.package];
			switch (testInfo.target.kind) {
				case 'lib':
					runArgs = runArgs.concat("--lib");
					break;
				case 'bin':
					runArgs = runArgs.concat("--bin", testInfo.target.name);
					break;
				case 'example':
					runArgs = runArgs.concat("--example", testInfo.target.name);
					break;
				case 'test':
					runArgs = runArgs.concat("--test", testInfo.target.name);
					break;
				case 'bench':
					runArgs = runArgs.concat("--bench", testInfo.target.name);
					break;
			}
			include.set(testInfo.target.package, {runArgs, filters: new Set(), report: testItem });
		}
		include.get(testInfo.target.package)!.filters.add(testInfo.name);
	});

	for (const [crate, testRun] of include.entries()) {
		const filters = testRun.filters.has([]) ? [] : [...testRun.filters.values()].map(it => it.join("::"));
		const skips = exclude.get(crate)? [...exclude.get(crate)!.values()].map(it => it.join("::")) : [];
		let args = testRun.runArgs
			.concat("--", "-Zunstable-options", "--format=json")
			.concat(skips.reduce((a: string[], skip) => [...a, "--skip", skip], []))
			.concat(filters);

		run.appendOutput('> cargo ', undefined, testRun.report);
		run.appendOutput(args.join(' '), undefined, testRun.report);
		run.appendOutput('\r\n', undefined, testRun.report);

		// Note: we don't set testRun.busy because child test busy sets an "in progress" icon for us

		var execTime = undefined;
		var failedCount = undefined;
		const exitCode = await Cargo.run(args,
			(stdout) => {
				const appendOutput = () => {
					run.appendOutput(stdout, undefined, testRun.report);
					run.appendOutput('\r\n', undefined, testRun.report);
				};

				const message = JSON.parse(stdout);
				if (message.type === 'suite' && message.exec_time) {
					execTime = message.exec_time;
					failedCount = message.failed;
				}
				if (message.type === 'test') {
					const fullName = crate + "::" + message.name;
					const specificTestItem = testDataRev.get(fullName)!;
					switch (message.event) {
						case "started":
							specificTestItem.busy = true;
							break;
						case "ok":
							specificTestItem.busy = false;
							run.passed(specificTestItem);
							break;
						case "ignored":
							specificTestItem.busy = false;
							break;
						case "failed":
							specificTestItem.busy = false;
							const stdout = message.stdout;
							run.failed(specificTestItem, new vscode.TestMessage(new vscode.MarkdownString(`~~~\n${stdout}\n~~~`)));
							break;
						default:
							appendOutput();
							run.failed(specificTestItem, new vscode.TestMessage(`Unhandled test event type ${message.event}`));
							log.warn(`Unhandled test event type ${message.event}`);
							break;
					}
				}
			},
			(stderr) => {
				run.appendOutput(stderr, undefined, testRun.report);
				run.appendOutput('\r\n', undefined, testRun.report);
			},
		);

		if (exitCode === 0) {
			run.passed(testRun.report, execTime);
		} else {
			run.failed(testRun.report, new vscode.TestMessage(`${failedCount} tests failed`));
		}
	}

	run.end();
}

export function activate(context: vscode.ExtensionContext) {
	testData = new WeakMap<vscode.TestItem, CargoTestItem>();
	testDataRev = new Map<string, vscode.TestItem>();
	controller = vscode.tests.createTestController('cad97.cargo-testing-panel.test-controller', "Cargo Tests");
	runProfile = controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, runHandler);

	controller.resolveHandler = resolveHandler;
	context.subscriptions.push(controller);
}

export function deactivate() {
	testData = undefined!;
	testDataRev = undefined!;
	controller = undefined!;
	runProfile = undefined!;
}
