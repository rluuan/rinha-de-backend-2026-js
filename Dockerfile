FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
COPY src/buildIndex.js ./src/
COPY data/ ./data/
RUN node src/buildIndex.js

FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY data/normalization.json ./data/
COPY data/mcc_risk.json ./data/
COPY --from=builder /app/index.bin ./index.bin
ENV INDEX_PATH=index.bin
ENV NORM_PATH=data/normalization.json
ENV MCC_PATH=data/mcc_risk.json
ENV PORT=9999
EXPOSE 9999
CMD ["node", "src/server.js"]
