import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";

const DIMS = 14;
const INPUT = process.env.REFS_GZ || "data/references.json.gz";
const OUTPUT = process.env.INDEX_BIN || "index.bin";
const K = 1024;
const KMEANS_ITERS = 10;
const KMEANS_SAMPLES = 100000;

function quantize(v) {
  let q = v * 127;
  q = q >= 0 ? Math.floor(q + 0.5) : Math.ceil(q - 0.5);
  if (q > 127) q = 127;
  if (q < -127) q = -127;
  return q;
}

class GrowableBytes {
  constructor(initial = 1 << 20) {
    this.buf = Buffer.allocUnsafe(initial);
    this.len = 0;
  }
  push(byte) {
    if (this.len === this.buf.length) {
      const bigger = Buffer.allocUnsafe(this.buf.length * 2);
      this.buf.copy(bigger);
      this.buf = bigger;
    }
    this.buf[this.len++] = byte;
  }
  slice() {
    return this.buf.subarray(0, this.len);
  }
}

async function main() {
  const started = Date.now();
  console.log(`[buildIndex] lendo ${INPUT} ...`);

  const labelsBuf = new GrowableBytes(4 << 20);
  const vectorsBuf = new GrowableBytes(64 << 20);
  let count = 0;
  let pending = "";
  
  const gunzip = fs.createReadStream(INPUT).pipe(zlib.createGunzip());
  gunzip.setEncoding("utf8");

  for await (const chunk of gunzip) {
    pending += chunk;
    let start = pending.indexOf("{");
    let end = pending.indexOf("}", start);
    while (start !== -1 && end !== -1) {
      const rec = JSON.parse(pending.slice(start, end + 1));
      const vec = rec.vector;
      for (let k = 0; k < DIMS; k++) {
        vectorsBuf.push(quantize(vec[k]));
      }
      labelsBuf.push(rec.label === "fraud" ? 1 : 0);
      count++;

      if (count % 500000 === 0) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`[buildIndex] lidos ${count} vetores (${secs}s)`);
      }

      start = pending.indexOf("{", end + 1);
      end = start === -1 ? -1 : pending.indexOf("}", start);
    }
    pending = start === -1 ? "" : pending.slice(start);
  }

  if (count === 0) throw new Error("nenhum vetor lido");

  const rawVectors = new Int8Array(vectorsBuf.buf.buffer, vectorsBuf.buf.byteOffset, count * DIMS);
  const rawLabels = new Int8Array(labelsBuf.buf.buffer, labelsBuf.buf.byteOffset, count);

  console.log(`[buildIndex] Treinando K-Means (K=${K}, amostragem=${KMEANS_SAMPLES})...`);
  const centroids = new Int8Array(K * DIMS);
  const numSamples = Math.min(count, KMEANS_SAMPLES);
  
  for (let c = 0; c < K; c++) {
    const idx = Math.floor(Math.random() * count);
    for (let d = 0; d < DIMS; d++) {
      centroids[c * DIMS + d] = rawVectors[idx * DIMS + d];
    }
  }

  for (let iter = 0; iter < KMEANS_ITERS; iter++) {
    const sums = new Int32Array(K * DIMS);
    const counts = new Int32Array(K);
    
    for (let i = 0; i < numSamples; i++) {
      const idx = Math.floor((i * count) / numSamples);
      let bestC = -1;
      let bestDist = Infinity;
      const vOffset = idx * DIMS;
      
      for (let c = 0; c < K; c++) {
        const cOffset = c * DIMS;
        let dist = 0;
        for (let d = 0; d < DIMS; d++) {
          const diff = rawVectors[vOffset + d] - centroids[cOffset + d];
          dist += diff * diff;
        }
        if (dist < bestDist) {
          bestDist = dist;
          bestC = c;
        }
      }
      
      counts[bestC]++;
      for (let d = 0; d < DIMS; d++) {
        sums[bestC * DIMS + d] += rawVectors[vOffset + d];
      }
    }
    
    for (let c = 0; c < K; c++) {
      if (counts[c] > 0) {
        for (let d = 0; d < DIMS; d++) {
          centroids[c * DIMS + d] = Math.round(sums[c * DIMS + d] / counts[c]);
        }
      }
    }
    console.log(`[buildIndex] K-Means iteração ${iter+1}/${KMEANS_ITERS} concluída.`);
  }

  console.log(`[buildIndex] Atribuindo ${count} vetores aos clusters...`);
  const assignments = new Int32Array(count);
  const sizes = new Int32Array(K);
  
  for (let i = 0; i < count; i++) {
    let bestC = -1;
    let bestDist = Infinity;
    const vOffset = i * DIMS;
    
    for (let c = 0; c < K; c++) {
      const cOffset = c * DIMS;
      let dist = 0;
      for (let d = 0; d < DIMS; d++) {
        const diff = rawVectors[vOffset + d] - centroids[cOffset + d];
        dist += diff * diff;
      }
      if (dist < bestDist) {
        bestDist = dist;
        bestC = c;
      }
    }
    assignments[i] = bestC;
    sizes[bestC]++;
    
    if ((i + 1) % 500000 === 0) {
      console.log(`[buildIndex] ... ${i + 1} atribuições realizadas`);
    }
  }

  console.log(`[buildIndex] Agrupando vetores...`);
  const offsets = new Int32Array(K);
  offsets[0] = 0;
  for (let c = 1; c < K; c++) {
    offsets[c] = offsets[c - 1] + sizes[c - 1];
  }

  const currentPos = new Int32Array(offsets);
  const groupedLabels = new Int8Array(count);
  const groupedVectors = new Int8Array(count * DIMS);

  for (let i = 0; i < count; i++) {
    const c = assignments[i];
    const pos = currentPos[c]++;
    groupedLabels[pos] = rawLabels[i];
    
    const srcOff = i * DIMS;
    const dstOff = pos * DIMS;
    for (let d = 0; d < DIMS; d++) {
      groupedVectors[dstOff + d] = rawVectors[srcOff + d];
    }
  }

  console.log(`[buildIndex] Gravando ${OUTPUT}...`);
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32LE(count, 0);
  header.writeUInt32LE(K, 4);

  const out = path.resolve(OUTPUT);
  const fd = fs.openSync(out, "w");
  fs.writeSync(fd, header);
  fs.writeSync(fd, Buffer.from(centroids.buffer));
  fs.writeSync(fd, Buffer.from(offsets.buffer));
  fs.writeSync(fd, Buffer.from(sizes.buffer));
  fs.writeSync(fd, Buffer.from(groupedLabels.buffer));
  fs.writeSync(fd, Buffer.from(groupedVectors.buffer));
  fs.closeSync(fd);

  const sizeMB = (fs.statSync(out).size / 1e6).toFixed(1);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[buildIndex] OK -> ${out} | ${count} vetores | K=${K} | ${sizeMB} MB | ${secs}s`);
}

main().catch((err) => {
  console.error("[buildIndex] ERRO:", err);
  process.exit(1);
});
