// child-process - runs a child that is really killed, without depending on piped stdio.
//
// Some sandboxes give a child no piped stdout, so a parent waiting for an acknowledgement on a pipe would
// wait for ever. Here a child writes each acknowledgement as one line of JSON appended to a file the
// parent names; the parent polls that file, and when the child says it is ready the parent sends it
// SIGKILL. The child's stdin and stdout are ignored and its stderr inherited, so nothing waits on a pipe.
import { spawn } from "node:child_process";
import fs from "node:fs";

/** Appends one acknowledgement, a line of JSON, to the parent's acknowledgement file (used by a child). */
export function acknowledge(ackFile, message) {
	fs.appendFileSync(ackFile, `${JSON.stringify(message)}\n`);
}

/** Reads the whole lines of an acknowledgement file, ignoring a last line not yet finished. */
function readAcks(ackFile) {
	if (!fs.existsSync(ackFile)) return [];
	const text = fs.readFileSync(ackFile, "utf8");
	return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
}

/**
 * Spawns `node script ...args`, the last argument being the acknowledgement file, waits until the child
 * acknowledges `{ ready: true }`, kills it with SIGKILL, and resolves with every other acknowledgement
 * once it has exited by that signal. Rejects if the child reports an error, exits by itself, or is not
 * ready within `timeoutMs`.
 */
export function runUntilReadyThenKill(script, args, ackFile, { timeoutMs = 30_000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, ...args, ackFile], { stdio: ["ignore", "ignore", "inherit"] });
		let killed = false;
		let failure;
		const started = Date.now();
		const poll = setInterval(() => {
			if (killed) return;
			let acks;
			try {
				acks = readAcks(ackFile);
			} catch (error) {
				failure = error;
			}
			const error = acks?.find((m) => m.error);
			if (error) failure = new Error(`the child reported ${JSON.stringify(error.error)}`);
			else if (!failure && Date.now() - started > timeoutMs) failure = new Error(`the child was not ready within ${timeoutMs} ms`);
			if (failure || acks?.some((m) => m.ready)) {
				killed = true;
				child.kill("SIGKILL");
			}
		}, 5);
		child.on("error", (error) => { clearInterval(poll); reject(error); });
		child.on("exit", (code, signal) => {
			clearInterval(poll);
			if (failure) reject(failure);
			else if (!killed || signal !== "SIGKILL") reject(new Error(`the child exited by itself: code ${code}, signal ${signal}`));
			else resolve(readAcks(ackFile).filter((m) => !m.ready));
		});
	});
}
