import fs from "node:fs";

const DIMS = 14;
const KNN = 5;
const THRESHOLD = 0.6;
const N_PROBE = 4;

export class VectorSearch {
  constructor({
    indexPath = "index.bin",
    normPath = "data/normalization.json",
    mccPath = "data/mcc_risk.json",
  } = {}) {
    this.norm = JSON.parse(fs.readFileSync(normPath, "utf8"));
    this.mcc = JSON.parse(fs.readFileSync(mccPath, "utf8"));

    const buf = fs.readFileSync(indexPath);
    
    this.count = buf.readUInt32LE(0);
    this.K = buf.readUInt32LE(4);

    let offset = 8;
    
    this.centroids = new Int8Array(buf.buffer, buf.byteOffset + offset, this.K * DIMS);
    offset += this.K * DIMS;

    this.offsets = new Int32Array(buf.buffer, buf.byteOffset + offset, this.K);
    offset += this.K * 4;

    this.sizes = new Int32Array(buf.buffer, buf.byteOffset + offset, this.K);
    offset += this.K * 4;

    this.labels = new Int8Array(buf.buffer, buf.byteOffset + offset, this.count);
    offset += this.count;

    this.vectors = new Int8Array(
      buf.buffer,
      buf.byteOffset + offset,
      this.count * DIMS
    );

    this._q = new Int32Array(DIMS);
  }

  _clamp01(v) {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  _roundHalfAway(x) {
    return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
  }

  _round4(v) {
    return this._roundHalfAway(v * 10000) / 10000;
  }

  _quantize(v) {
    let q = this._roundHalfAway(v * 127);
    if (q > 127) q = 127;
    if (q < -127) q = -127;
    return q;
  }

  _dayOfWeek(y, m, d) {
    const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    if (m < 3) y--;
    const dow = (y + ((y / 4) | 0) - ((y / 100) | 0) + ((y / 400) | 0) + t[m - 1] + d) % 7;
    return (dow + 6) % 7;
  }

  _parseTS(ts) {
    return {
      y: +ts.slice(0, 4),
      mo: +ts.slice(5, 7),
      d: +ts.slice(8, 10),
      h: +ts.slice(11, 13),
      mi: +ts.slice(14, 16),
      s: +ts.slice(17, 19),
    };
  }

  _epochSeconds(p) {
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000;
  }

  vectorize(req) {
    const n = this.norm;
    const tx = req.transaction;
    const cust = req.customer;
    const merch = req.merchant;
    const term = req.terminal;
    const last = req.last_transaction;

    const t = this._parseTS(tx.requested_at);
    const out = new Array(DIMS);

    out[0] = this._clamp01(tx.amount / n.max_amount);
    out[1] = this._clamp01(tx.installments / n.max_installments);
    out[2] = this._clamp01((tx.amount / cust.avg_amount) / n.amount_vs_avg_ratio);
    out[3] = t.h / 23.0;
    out[4] = this._dayOfWeek(t.y, t.mo, t.d) / 6.0;

    if (last) {
      const lt = this._parseTS(last.timestamp);
      const mins = (this._epochSeconds(t) - this._epochSeconds(lt)) / 60.0;
      out[5] = this._clamp01(mins / n.max_minutes);
      out[6] = this._clamp01(last.km_from_current / n.max_km);
    } else {
      out[5] = -1.0;
      out[6] = -1.0;
    }

    out[7] = this._clamp01(term.km_from_home / n.max_km);
    out[8] = this._clamp01(cust.tx_count_24h / n.max_tx_count_24h);
    out[9] = term.is_online ? 1.0 : 0.0;
    out[10] = term.card_present ? 1.0 : 0.0;

    out[11] = 1.0;
    const known = cust.known_merchants;
    for (let i = 0; i < known.length; i++) {
      if (known[i] === merch.id) {
        out[11] = 0.0;
        break;
      }
    }

    out[12] = merch.mcc in this.mcc ? this.mcc[merch.mcc] : 0.5;
    out[13] = this._clamp01(merch.avg_amount / n.max_merchant_avg_amount);

    for (let i = 0; i < DIMS; i++) out[i] = this._round4(out[i]);
    return out;
  }

  search(vec) {
    const q = this._q;
    for (let k = 0; k < DIMS; k++) q[k] = this._quantize(vec[k]);

    const bestClustersDist = new Int32Array(N_PROBE);
    const bestClustersIdx = new Int32Array(N_PROBE);
    bestClustersDist.fill(2147483647);
    bestClustersIdx.fill(-1);

    const C = this.centroids;
    const K = this.K;

    for (let c = 0; c < K; c++) {
      const cOffset = c * DIMS;
      let dist = 0;
      for (let k = 0; k < DIMS; k++) {
        const d = q[k] - C[cOffset + k];
        dist += d * d;
      }
      
      if (dist < bestClustersDist[N_PROBE - 1]) {
        let j = N_PROBE - 1;
        while (j > 0 && dist < bestClustersDist[j - 1]) {
          bestClustersDist[j] = bestClustersDist[j - 1];
          bestClustersIdx[j] = bestClustersIdx[j - 1];
          j--;
        }
        bestClustersDist[j] = dist;
        bestClustersIdx[j] = c;
      }
    }

    const dist = [Infinity, Infinity, Infinity, Infinity, Infinity];
    const idx = [-1, -1, -1, -1, -1];

    const V = this.vectors;

    for (let p = 0; p < N_PROBE; p++) {
      const c = bestClustersIdx[p];
      if (c === -1) continue;
      
      const start = this.offsets[c];
      const size = this.sizes[c];
      const end = start + size;

      for (let i = start; i < end; i++) {
        const base = i * DIMS;
        let sum = 0;
        for (let k = 0; k < DIMS; k++) {
          const d = q[k] - V[base + k];
          sum += d * d;
        }
        
        if (sum < dist[4]) {
          let j = 4;
          while (j > 0 && sum < dist[j - 1]) {
            dist[j] = dist[j - 1];
            idx[j] = idx[j - 1];
            j--;
          }
          dist[j] = sum;
          idx[j] = i;
        }
      }
    }

    let fraudN = 0;
    for (let i = 0; i < KNN; i++) {
      if (idx[i] >= 0 && this.labels[idx[i]] === 1) fraudN++;
    }
    const fraudScore = fraudN / KNN;
    return { approved: fraudScore < THRESHOLD, fraud_score: fraudScore };
  }

  score(req) {
    return this.search(this.vectorize(req));
  }
}
