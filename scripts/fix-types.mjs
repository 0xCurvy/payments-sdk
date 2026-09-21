import fs from "node:fs";
const file = new URL("../src/test/payments.test.ts", import.meta.url);
let t = fs.readFileSync(file, "utf8");
t = t.replace(/txHash: `\$\{[^`]+\}`/g, (m) => m.replace("txHash:", "txHash:") );
const hashes = [
  ["txHash: `0x${\"ab\".repeat(32)}`", "txHash: `0x${\"ab\".repeat(32)}` as Hex"],
];
for (const [from, to] of [
  ["txHash,", "txHash: txHash as Hex,"],
]) {}
t = t.replace(/txHash = `\$\{"ab"\.repeat\(32\)\}`;/, 'const txHash = `0x${"ab".repeat(32)}` as Hex;');
t = t.replace(/txHash: `\$\{"cd"\.repeat\(32\)\}`/g, 'txHash: `0x${"cd".repeat(32)}` as Hex');
t = t.replace(/txHash: `\$\{"de"\.repeat\(32\)\}`/g, 'txHash: `0x${"de".repeat(32)}` as Hex');
t = t.replace(/txHash: `\$\{"ef"\.repeat\(32\)\}`/g, 'txHash: `0x${"ef".repeat(32)}` as Hex');
t = t.replace(/const txHash = `\$\{"01"\.repeat\(32\)\}`;/g, 'const txHash = `0x${"01".repeat(32)}` as Hex;');
t = t.replace(/const txHash = `\$\{"02"\.repeat\(32\)\}`;/g, 'const txHash = `0x${"02".repeat(32)}` as Hex;');
t = t.replace(/hash: `\$\{"01"\.repeat\(32\)\}`/g, 'hash: `0x${"01".repeat(32)}` as Hex');
t = t.replace(/hash: `\$\{"02"\.repeat\(32\)\}`/g, 'hash: `0x${"02".repeat(32)}` as Hex');
fs.writeFileSync(file, t);
