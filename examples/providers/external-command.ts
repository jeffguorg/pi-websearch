// Fallback-only provider for a trusted local executable.
// Copy to ~/.pi/websearch/providers/external-command.ts, set
// PI_WEBSEARCH_EXECUTABLE to an absolute path, and keep the executable owned by
// the current user (or root) and not group/world-writable.
//
// Protocol: one JSON request on stdin; one JSON object on stdout:
// { "results": [{ "title": "...", "url": "https://...", "snippet": "..." }] }

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

function appendBounded(chunks: Buffer[], chunk: Buffer, current: number, max: number): number {
	const next = current + chunk.byteLength;
	if (next > max) throw new Error(`External search output exceeds ${max} bytes`);
	chunks.push(chunk);
	return next;
}

function resultItems(payload: unknown) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
	const results = (payload as Record<string, unknown>)["results"];
	if (!Array.isArray(results)) return [];
	return results.flatMap((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const item = value as Record<string, unknown>;
		const title = typeof item["title"] === "string" ? item["title"] : undefined;
		const url = typeof item["url"] === "string" ? item["url"] : undefined;
		if (!title || !url || !/^https?:\/\//.test(url)) return [];
		const snippet = typeof item["snippet"] === "string" ? item["snippet"] : undefined;
		return [{ title, url, ...(snippet ? { snippet } : {}) }];
	});
}

export default {
	provider: "external-command",
	async search(
		{
			request,
			maxResults,
			allowedDomains,
			blockedDomains,
		}: {
			request: { query: string };
			maxResults: number;
			allowedDomains?: string[];
			blockedDomains?: string[];
		},
		signal: AbortSignal,
	) {
		if (signal.aborted) throw signal.reason;
		const executable = process.env["PI_WEBSEARCH_EXECUTABLE"];
		if (!executable || !isAbsolute(executable)) {
			throw new Error("PI_WEBSEARCH_EXECUTABLE must be an absolute path");
		}
		const metadata = await stat(executable);
		if (!metadata.isFile() || (metadata.mode & 0o022) !== 0 || (metadata.uid !== process.getuid() && metadata.uid !== 0)) {
			throw new Error("External search executable has unsafe ownership or permissions");
		}

		if (signal.aborted) throw signal.reason;
		const child = spawn(executable, [], {
			cwd: "/tmp",
			env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let outputError: Error | undefined;
		child.stdout.on("data", (chunk: Buffer) => {
			try {
				stdoutBytes = appendBounded(stdout, chunk, stdoutBytes, MAX_STDOUT_BYTES);
			} catch (error) {
				outputError = error instanceof Error ? error : new Error("External search output is invalid");
				child.kill("SIGKILL");
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			try {
				stderrBytes = appendBounded(stderr, chunk, stderrBytes, MAX_STDERR_BYTES);
			} catch {
				child.kill("SIGKILL");
			}
		});
		const onAbort = () => child.kill("SIGKILL");
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		child.stdin.on("error", () => undefined);
		child.stdin.end(
			JSON.stringify({
				version: 1,
				query: request.query,
				maxResults,
				...(allowedDomains ? { allowedDomains } : {}),
				...(blockedDomains ? { blockedDomains } : {}),
			}),
		);

		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
			if (signal.aborted) throw signal.reason;
			if (outputError) throw outputError;
			if (code !== 0) {
				const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 500);
				throw new Error(`External search exited with code ${code}${detail ? `: ${detail}` : ""}`);
			}
			return resultItems(JSON.parse(Buffer.concat(stdout).toString("utf8")));
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	},
};
