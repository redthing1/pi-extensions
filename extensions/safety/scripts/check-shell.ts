import { checkShellClassifier } from "./check/shell.js";

checkShellClassifier({ cwd: process.cwd() });
console.log("safety shell check: ok");
