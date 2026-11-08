import { strict as assert } from "node:assert";
import { inspectCommand, type GuardContext } from "../policy.ts";
import { inspectTraversal } from "../reckless.ts";

const remote: GuardContext = { cwd: "/workspace/project", home: "/home/remote", pathStyle: "posix" };
const catastrophic = [
	"rm -r /",
	"rm -rf ~",
	"rm -r $HOME",
	"rm -r /home/remote",
	"rm -r /workspace/project",
	"rm -r ../project",
	'rm -r "$TARGET"',
	"sudo /bin/rm -r /",
	"bash -c 'rm -r /'",
	"chmod -R 777 /home/remote",
	"find / -delete",
	"find / -exec /bin/rm {} +",
	"find / -execdir /bin/rm {} +",
	"rsync -a --delete empty/ /home/remote/",
	"dd if=/dev/zero of=/dev/sda",
	"cat disk.img > /dev/sda",
	"cd /; rm -r home",
	"env -C / rm -r home",
	"sudo --chdir=/ rm -r home",
];
const reckless = [
	"env -C/ find .",
	"sudo -D/ find .",
	"ls -R --color /",
	"grep -R --color needle /",
	"ls -R --hyperlink /",
	"find / -name needle",
	"find // -name needle",
	"find /tmp/.. -name needle",
	"find -H / -type f",
	"find -x / -name needle",
	"find /tmp / -name needle",
	"fd needle /",
	"fd -g '*.ts' /",
	"fd --search-path=/ needle",
	"fd --base-directory / needle",
	"rg --files /",
	"rg needle /",
	"rg -e needle /",
	"rg -e / --files /",
	"rg --glob '*.ts' needle /",
	"rg -- needle /",
	"grep -R needle /",
	"grep -rn needle /",
	"grep --directories=recurse needle /",
	"grep -R -e needle /",
	"du -sh /",
	"du --max-depth=1 /",
	"ls -R /",
	"ls -laR /",
	"tree /",
	"tree -L 2 /",
	"sudo find / -name needle",
	"env X=1 command find /",
	"busybox find /",
	"bash -c 'find / -name needle'",
	"echo $(find / -name needle)",
	"cd / && find .",
	"env -C / find .",
	"env --chdir=/ rg --files",
	"sudo -D / find .",
	"find / -xdev -name needle",
	"find / -name needle | head -1",
	"Get-ChildItem / -Recurse",
	"gci -Path / -Depth 5",
];
const allowed = [
	"find /a -name needle",
	"rm -rf dist",
	"rm -rf /tmp/task-output",
	"rm -r /home/remote/project-output",
	"find . -name needle",
	"find /workspace/project -name needle",
	"find / -maxdepth 1 -type d",
	"find / -maxdepth 0",
	"find / -maxdepth 1 -exec echo {} +",
	"find /tmp -name /",
	"fd needle .",
	"fd /",
	"fd -d1 needle /",
	"fd --max-depth=1 needle /",
	"fd --glob /",
	"fd -e ts needle /workspace",
	"rg '/' .",
	"rg -e / .",
	"rg --glob / needle .",
	"rg --files /workspace",
	"rg --files --max-depth 1 /",
	"grep needle /",
	"grep -R / .",
	"grep -R -f /pattern-file .",
	"du -sh /workspace",
	"ls /",
	"ls -l /",
	"tree -L 1 /",
	"stat /",
	"echo 'find / -delete'",
	"echo '$(find /)'",
	"cat <<'EOF'\nfind / -delete\nEOF",
	"Get-ChildItem /",
	"Get-ChildItem / -Recurse -Depth 1",
	"cd /tmp && find .",
	"env -C /tmp find .",
];

for (const command of catastrophic) assert.equal(inspectCommand(command, remote)?.category, "catastrophic", command);
for (const command of reckless) assert.equal(inspectCommand(command, remote)?.category, "reckless", command);
for (const command of allowed) assert.equal(inspectCommand(command, remote), undefined, command);

assert.equal(
	inspectCommand("rm -r /reference", { ...remote, protectedPaths: ["/reference"] })?.category,
	"catastrophic",
);
assert.equal(inspectCommand("find .", { ...remote, cwd: "/" })?.category, "reckless");
assert.equal(inspectCommand("ls / -Recurse", { ...remote, shell: "powershell" })?.category, "reckless");
assert.equal(inspectCommand("pwsh -Command 'ls / -Recurse'", remote)?.category, "reckless");
assert.equal(inspectCommand("find /workspace -name needle", { ...remote, home: "/workspace" }), undefined);
assert.equal(inspectTraversal(["../.."], remote)?.category, "reckless");
assert.equal(inspectTraversal(["/workspace"], remote), undefined);

const windows: GuardContext = { cwd: "C:\\work\\project", home: "C:\\Users\\remote", pathStyle: "win32" };
for (const command of ["find C:/ -name needle", "rg --files 'C:\\'", "tree C:/", "find //server/share -name needle"]) {
	assert.equal(inspectCommand(command, windows)?.category, "reckless", command);
}
for (const command of ["rm -r C:/Users/remote", "powershell -Command 'Remove-Item -Recurse C:/Users/remote'"]) {
	assert.equal(inspectCommand(command, windows)?.category, "catastrophic", command);
}
assert.equal(inspectCommand("rg --files C:/work/project", windows), undefined);

console.log(
	`execution guard policy: ${catastrophic.length + reckless.length + allowed.length} command cases and destination checks passed`,
);
