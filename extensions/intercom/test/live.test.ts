import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { IntercomClient, type PeerMessage } from "../client.ts";

test.skipIf(!process.env.INTERCOM_TEST_BIN)("CLI adapters exchange messages and replace identities", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "intercom-adapter-"));
	const previous = process.env.INTERCOM_DIR;
	process.env.INTERCOM_DIR = join(fixture, "runtime");
	const clients: IntercomClient[] = [];
	const failures: Error[] = [];
	const received: PeerMessage[] = [];
	let flowing = true;
	try {
		const a = await IntercomClient.start(
			process.env.INTERCOM_TEST_BIN!,
			"api",
			() => true,
			(error) => failures.push(error),
		);
		clients.push(a);
		const b = await IntercomClient.start(
			process.env.INTERCOM_TEST_BIN!,
			"review",
			(message) => {
				received.push(message);
				return flowing;
			},
			(error) => failures.push(error),
		);
		clients.push(b);
		expect(await a.list()).toEqual(expect.arrayContaining([a.peer, b.peer]));
		const id = await a.send(b.peer.id, "Ready 🦀");
		await expect.poll(() => received.length, { timeout: 2000 }).toBe(1);
		expect(received[0]).toEqual({ id, from: a.peer, text: "Ready 🦀" });
		await a.stop();
		expect(await b.list()).toEqual([b.peer]);
		const replacement = await IntercomClient.start(
			process.env.INTERCOM_TEST_BIN!,
			"api",
			() => true,
			(error) => failures.push(error),
		);
		clients.push(replacement);
		expect(replacement.peer.id).not.toBe(a.peer.id);
		await expect(b.send(a.peer.id, "Old identity")).rejects.toThrow("no longer registered");
		flowing = false;
		await replacement.send(b.peer.id, "Pause intake");
		await expect.poll(() => received.length, { timeout: 2000 }).toBe(2);
		await replacement.send(b.peer.id, "x".repeat(16384));
		await b.stop();
		expect(await replacement.list()).toEqual([replacement.peer]);
		expect(failures).toEqual([]);
	} finally {
		await Promise.all(clients.map((client) => client.stop()));
		if (previous === undefined) delete process.env.INTERCOM_DIR;
		else process.env.INTERCOM_DIR = previous;
		rmSync(fixture, { recursive: true, force: true });
	}
});
