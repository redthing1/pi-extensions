import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type MasterConnection, quotePosix } from "./master.ts";

export const WORKER_ASSETS = [
	"worker.mjs",
	"protocol.mjs",
	"paths.mjs",
	"files.mjs",
	"processes.mjs",
	"resources.mjs",
] as const;
const DEFAULT_WORKER = fileURLToPath(new URL("../worker/worker.mjs", import.meta.url));

/** One endpoint directory, allocated exclusively and never discovered by scanning. */
export class RemoteScratch {
	readonly path: string;
	readonly workerPath: string;
	private allocated = false;
	private readonly master: MasterConnection;
	private readonly nonce: string;

	constructor(master: MasterConnection, nonce: string) {
		if (!/^[a-f0-9]{32}$/u.test(nonce)) throw new Error("Invalid scratch ownership token");
		this.master = master;
		this.nonce = nonce;
		this.path = `/tmp/pi-teleport-${nonce}`;
		this.workerPath = `${this.path}/worker.mjs`;
	}

	async create(): Promise<void> {
		if (this.allocated) throw new Error("Remote scratch is already allocated");
		this.allocated = true;
		const result = await this.master.run(
			`umask 077; mkdir -- ${quotePosix(this.path)} && printf %s ${quotePosix(this.nonce)} > ${quotePosix(`${this.path}/.owner`)}`,
		);
		if (result.code !== 0) throw new Error("Unable to create exclusive Teleport scratch");
	}

	async installWorker(workerPath = DEFAULT_WORKER): Promise<void> {
		if (!this.allocated) throw new Error("Remote scratch is not allocated");
		for (const name of WORKER_ASSETS) {
			await this.master.upload(join(dirname(workerPath), name), `${this.path}/${name}`);
		}
	}

	get needsCleanup(): boolean {
		return this.allocated;
	}

	async remove(master = this.master): Promise<void> {
		if (!this.allocated) return;
		const path = quotePosix(this.path);
		const marker = quotePosix(`${this.path}/.owner`);
		const command = `if [ ! -e ${path} ] && [ ! -L ${path} ]; then exit 0; fi; [ -d ${path} ] && [ ! -L ${path} ] && [ -f ${marker} ] && [ ! -L ${marker} ] && [ "$(cat -- ${marker})" = ${quotePosix(this.nonce)} ] || exit 73; rm -rf -- ${path}; [ ! -e ${path} ] && [ ! -L ${path} ]`;
		const result = await master.run(command, undefined, 2_000);
		if (result.code !== 0) throw new Error("Teleport could not confirm removal of its owned remote scratch");
		this.allocated = false;
	}
}
