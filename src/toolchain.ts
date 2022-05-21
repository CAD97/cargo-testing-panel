import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import * as vscode from "vscode";
import { execute, log, memoizeAsync } from "./util";

export interface CompilationArtifact {
    fileName: string;
    packageName: string;
    name: string;
    kind: string;
    isTest: boolean;
}

export interface ArtifactSpec {
    cargoArgs: string[];
    filter?: (artifacts: CompilationArtifact[]) => CompilationArtifact[];
}

const cwd = () => vscode.workspace.workspaceFolders? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;

export class Cargo {
    constructor(readonly output: vscode.OutputChannel) {}

    // Made public for testing purposes
    static artifactSpec(args: readonly string[]): ArtifactSpec {
        const cargoArgs = [...args, "--message-format=json"];

        // arguments for a runnable from the quick pick should be updated.
        // see crates\rust-analyzer\src\main_loop\handlers.rs, handle_code_lens
        switch (cargoArgs[0]) {
            case "run":
                cargoArgs[0] = "build";
                break;
            case "test": {
                if (!cargoArgs.includes("--no-run")) {
                    cargoArgs.push("--no-run");
                }
                break;
            }
        }

        const result: ArtifactSpec = { cargoArgs: cargoArgs };
        if (cargoArgs[0] === "test") {
            // for instance, `crates\rust-analyzer\tests\heavy_tests\main.rs` tests
            // produce 2 artifacts: {"kind": "bin"} and {"kind": "test"}
            result.filter = (artifacts) => artifacts.filter((it) => it.isTest);
        }

        return result;
    }

    private async getArtifacts(spec: ArtifactSpec): Promise<CompilationArtifact[]> {
        const artifacts: CompilationArtifact[] = [];

        try {
            await Cargo.run(
                spec.cargoArgs,
                (line) => {
                    const message = JSON.parse(line);
                    if (message.reason === "compiler-artifact" && message.executable) {
                        const isBinary = message.target.crate_types.includes("bin");
                        const isBuildScript = message.target.kind.includes("custom-build");
                        if ((isBinary && !isBuildScript) || message.profile.test) {
                            artifacts.push({
                                fileName: message.executable,
                                packageName: message.package_id.split(' ')[0],
                                name: message.target.name,
                                kind: message.target.kind[0],
                                isTest: message.profile.test,
                            });
                        }
                    } else if (message.reason === "compiler-message") {
                        const rendered = message.message.rendered;
                        this.output.append(rendered.split("\n").join("\r\n"));
                    }
                },
                (line) => this.output.append(line)
            );
        } catch (err) {
            // this.output.show(true);
            // throw new Error(`Cargo invocation has failed: ${err}`);
        }

        return spec.filter?.(artifacts) ?? artifacts;
    }

    async artifactsFromArgs(args: readonly string[]): Promise<CompilationArtifact[]> {
        return await this.getArtifacts(Cargo.artifactSpec(args));
    }

    async executableFromArgs(args: readonly string[]): Promise<string> {
        const artifacts = await this.artifactsFromArgs(args);

        if (artifacts.length === 0) {
            throw new Error("No compilation artifacts");
        } else if (artifacts.length > 1) {
            throw new Error("Multiple compilation artifacts are not supported.");
        }

        return artifacts[0].fileName;
    }

    static async run(
        cargoArgs: string[],
        onStdout: (data: string) => void,
        onStderr: (data: string) => void
    ): Promise<number> {
        const path = await cargoPath();
        return await new Promise((resolve, reject) => {
            const cargo = cp.spawn(path, cargoArgs, {
                stdio: ["ignore", "pipe", "pipe"],
                cwd: cwd(),
            });

            cargo.on("error", (err) => reject(new Error(`could not launch cargo: ${err}`)));

            readline.createInterface({ input: cargo.stderr }).on("line", onStderr);
            readline.createInterface({ input: cargo.stdout }).on("line", onStdout);

            cargo.on("exit", (exitCode, _) => {
                if (exitCode === 0) { resolve(exitCode); }
                else { reject(new Error(`exit code: ${exitCode}.`)); }
            });
        });
    }

    static async runUnified(
        cargoArgs: string[],
        onLine: (data: string) => void,
    ): Promise<number> {
        const path = await cargoPath();
        return await new Promise((resolve, reject) => {
            const cargo = cp.spawn(path, cargoArgs, {
                stdio: ["ignore", "pipe", "pipe"],
                cwd: cwd(),
            });

            cargo.on("error", (err) => reject(new Error(`could not launch cargo: ${err}`)));

            // I am not a JS/TS/Node developer. I have no idea if there is a *proper* way to do this.
            // Every time I tried to do this, it failed, because the callbacks are not sequentialized.
            // They need to be. So just build up a huge string as we go and call it a day?

            let merged = "";

            cargo.stderr.on("data", (chunk) => merged += chunk);
            cargo.stdout.on("data", (chunk) => merged += chunk);

            cargo.on("exit", (exitCode, _) => {
                for (const line of merged.split('\n')) {
                    onLine(line);
                }
                if (exitCode === 0) { resolve(exitCode); }
                else { reject(new Error(`exit code: ${exitCode}.`)); }
            });
        });
    }
}

/** Mirrors `toolchain::cargo()` implementation */
export function cargoPath(): Promise<string> {
    return getPathForExecutable("cargo");
}

/** Mirrors `toolchain::get_path_for_executable()` implementation */
export const getPathForExecutable = memoizeAsync(
    // We apply caching to decrease file-system interactions
    async (executableName: "cargo" | "rustc" | "rustup"): Promise<string> => {
        {
            const envVar = process.env[executableName.toUpperCase()];
            if (envVar) { return envVar; }
        }

        if (await lookupInPath(executableName)) { return executableName; }

        try {
            // hmm, `os.homedir()` seems to be infallible
            // it is not mentioned in docs and cannot be infered by the type signature...
            const standardPath = vscode.Uri.joinPath(
                vscode.Uri.file(os.homedir()),
                ".cargo",
                "bin",
                executableName
            );

            if (await isFileAtUri(standardPath)) { return standardPath.fsPath; }
        } catch (err) {
            log.error("Failed to read the fs info", err);
        }
        return executableName;
    }
);

async function lookupInPath(exec: string): Promise<boolean> {
    const paths = process.env.PATH ?? "";

    const candidates = paths.split(path.delimiter).flatMap((dirInPath) => {
        const candidate = path.join(dirInPath, exec);
        return os.type() === "Windows_NT" ? [candidate, `${candidate}.exe`] : [candidate];
    });

    for await (const isFile of candidates.map(isFileAtPath)) {
        if (isFile) {
            return true;
        }
    }
    return false;
}

async function isFileAtPath(path: string): Promise<boolean> {
    return isFileAtUri(vscode.Uri.file(path));
}

async function isFileAtUri(uri: vscode.Uri): Promise<boolean> {
    try {
        return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) !== 0;
    } catch {
        return false;
    }
}
