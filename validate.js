import fs from "node:fs";
import { VectorSearch } from "./src/vectorSearch.js";

console.log("Carregando index.bin...");
const vs = new VectorSearch();
console.log(`${vs.count.toLocaleString()} vetores carregados.\n`);

console.log("Lendo test-data.json...");
const data = JSON.parse(fs.readFileSync("testdata/test-data.json", "utf8"));
const entries = data.entries;
console.log(`${entries.length.toLocaleString()} transações para validar.\n`);

let correct = 0, errors = 0, fp = 0, fn = 0;
const t0 = Date.now();

for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  const { approved } = vs.score(e.request);

  if (approved === e.expected_approved) {
    correct++;
  } else {
    errors++;
    if (approved && !e.expected_approved) fp++;
    else fn++;
  }

  if ((i + 1) % 5000 === 0) {
    const pct = ((i + 1) / entries.length * 100).toFixed(0);
    process.stdout.write(`\r  ${pct}% (${i + 1}/${entries.length})...`);
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const errRate = (errors / entries.length * 100).toFixed(2);
const accRate = (correct / entries.length * 100).toFixed(2);

console.log("\r" + " ".repeat(40));
console.log("=".repeat(40));
console.log(`Total:       ${entries.length.toLocaleString()}`);
console.log(`Acertos:     ${correct.toLocaleString()} (${accRate}%)`);
console.log(`Erros:       ${errors.toLocaleString()} (${errRate}%)`);
console.log(`  FP:        ${fp.toLocaleString()}`);
console.log(`  FN:        ${fn.toLocaleString()}`);
console.log("=".repeat(40));
console.log(`Resultado:   ${parseFloat(errRate) < 15 ? "✓ PASSA no corte" : "✗ ESTOURA o corte"}`);
console.log(`Tempo:       ${elapsed}s`);
