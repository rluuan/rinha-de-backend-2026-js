/*
 * server.js — sobe o HTTP e conecta tudo.
 *
 * Dois endpoints:
 *   GET  /ready        -> 200 quando o index.bin já está na memória
 *   POST /fraud-score  -> { approved: bool, fraud_score: number }
 *
 * Sem frameworks externos: só o http nativo do Node.
 */

import http from "node:http";
import { VectorSearch } from "./vectorSearch.js";

const PORT = Number(process.env.PORT) || 9999;

// Uma instância por processo — carrega index.bin 1x no boot (síncrono).
const vs = new VectorSearch();

const server = http.createServer((req, res) => {
  // Health check — o k6 (e o docker-compose depends_on) checa antes de começar.
  if (req.method === "GET" && req.url === "/ready") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }

  // Endpoint principal.
  if (req.method === "POST" && req.url === "/fraud-score") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"invalid json"}');
        return;
      }

      const result = vs.score(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

// Reutiliza conexões TCP entre requests (importante para aguentar 900 rps).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.listen(PORT, () => {
  console.log(`[server] :${PORT} | ${vs.count} vetores carregados`);
});
