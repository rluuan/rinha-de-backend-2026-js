# Rinha de Backend 2026 - Detecção de Fraude (IVF)

Esta é a submissão para a Rinha de Backend 2026, com foco em performance e aderência aos limites de **1 CPU e 350 MB de RAM**.

O projeto implementa uma busca vetorial utilizando um **Índice Invertido (IVF)** baseado em **K-Means**, com vetores de transação compactados em `Int8`. A solução opera 100% em memória RAM, eliminando o uso de bancos de dados externos.

## 🚀 Como Executar Localmente

### 1. Construir e Iniciar os Containers
Para subir o Nginx e as instâncias da API, execute o comando abaixo na raiz do projeto:

```bash
docker compose up --build -d
```
O build realiza o processamento do dataset (`references.json.gz`), executa o treinamento do K-Means e gera o binário `index.bin` (~45 MB) em tempo de compilação.

### 2. Testar a Rota da API
A API e o Load Balancer estarão expostos na porta `9999`.

```bash
curl -X POST http://localhost:9999/fraud-score \
  -H "Content-Type: application/json" \
  -d '{
    "id": "tx-123",
    "transaction": { "amount": 384.88, "installments": 3, "requested_at": "2024-01-01T10:00:00Z" },
    "customer": { "avg_amount": 769.76, "tx_count_24h": 3, "known_merchants": ["MERC-001"] },
    "merchant": { "id": "MERC-002", "mcc": "5912", "avg_amount": 298.95 },
    "terminal": { "is_online": false, "card_present": true, "km_from_home": 13.7 }
  }'
```

### 3. Validar Acurácia
Para executar a bateria de testes de acurácia contra o dataset oficial (`test-data.json`) sem instanciar os containers:
```bash
node validate.js
```

## Estrutura e Restrições
- **Load Balancer (Nginx):** Implementa round-robin puro na porta 9999. Nenhuma lógica de negócio aplicada.
- **2 Instâncias Node.js:** Limites estabelecidos via docker-compose (`0.45 CPU` e `160MB` cada).
- **Busca IVF (K-Means):** Limita o raio de busca a clusters específicos, eliminando cálculos O(N).

## Submissão (Branches)
Conforme as regras do repositório oficial, este projeto conta com duas branches principais:
- **`main`**: Contém o código-fonte completo (Node.js, dataset, buildIndex).
- **`submission`**: Branch reduzida, contendo apenas o `docker-compose.yml` na raiz e os metadados exigidos pela engine de teste oficial.
