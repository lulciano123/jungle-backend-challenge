
# Jungle Gaming — Distributed Wagering Processor

Implementação do [Backend Challenge da Jungle Gaming](https://github.com/junglegaming/backend-challenge), utilizando **Bun, NestJS, TypeScript, PostgreSQL e AWS SQS via MiniStack**.

O projeto implementa um serviço de processamento financeiro de apostas com API HTTP, consumidores de mensagens e publicação assíncrona de eventos. O foco está na integridade monetária, consistência transacional, idempotência persistente, concorrência entre instâncias e recuperação após falhas.

O PostgreSQL é a fonte de verdade para saldos, transações, ledger, Inbox e Outbox.

A implementação cobre o núcleo financeiro e a infraestrutura distribuída do desafio. As funcionalidades não concluídas estão identificadas na seção [Escopo e limitações](#escopo-e-limitações).

## 1. Visão geral

O sistema recebe operações financeiras de provedores de jogos e aplica seus efeitos sobre carteiras de jogadores.

As operações podem chegar pela API HTTP ou por mensagens SQS. Ambos os caminhos compartilham o mesmo processamento financeiro e as garantias de persistência.

### Operações suportadas

| Operação | Efeito no saldo | Ledger | Comportamento |
|---|---|---|---|
| `OPENING` | Crédito inicial | `CREDIT` | Operação interna de abertura de carteira |
| `BET` | Débito | `DEBIT` | Rejeita apostas sem saldo suficiente |
| `WIN` | Crédito | `CREDIT` | Registra o pagamento de uma vitória |
| `LOSS` | Nenhum | Nenhum | Registra o resultado sem movimentar saldo |
| `REFUND` | Crédito | `CREDIT` | Devolve integralmente uma `BET` processada |
| `ROLLBACK` | Movimento inverso | `DEBIT` ou `CREDIT` | Reverte uma operação financeira processada |

As operações `REFUND` e `ROLLBACK` exigem uma referência válida, respeitam o valor integral da transação original e possuem proteção contra reversões duplicadas.

Operações com referência ainda inexistente são registradas como `PENDING_REFERENCE`, sem movimentação financeira. O reprocessamento automático dessas pendências não faz parte da implementação atual.

## 2. Garantias financeiras

O processamento foi desenvolvido em torno das seguintes propriedades:

**Precisão monetária**

- Valores financeiros são representados por strings decimais.
- A classe `Money` utiliza `decimal.js`, sem operações com `number` para representar dinheiro.
- O PostgreSQL utiliza `NUMERIC(20,2)`.
- São suportadas as moedas `BRL` e `USD`, com validação de compatibilidade.
- Valores inválidos e operações que ultrapassam os limites monetários são rejeitados.

**Integridade e atomicidade**

- Alterações de saldo e lançamentos no ledger são confirmados na mesma transação SQL.
- O ledger é imutável, com proteção no schema do PostgreSQL.
- Constraints impedem saldos negativos, relações inválidas e registros financeiros inconsistentes.
- Operações rejeitadas não alteram o saldo nem geram lançamentos financeiros.
- A abertura de carteira com saldo positivo cria uma transação interna `OPENING` e um lançamento `CREDIT`.

**Concorrência**

- O PostgreSQL utiliza bloqueio por carteira com `SELECT ... FOR UPDATE`.
- Atualizações financeiras são condicionadas e executadas dentro de transações SQL.
- Não há lock global para todas as carteiras.
- Múltiplos processos podem disputar a mesma carteira sem depender de sincronização em memória.

**Idempotência**

- A chave de idempotência e a referência externa são persistidas no banco.
- O payload financeiro é identificado por hash SHA-256 de uma representação canônica.
- Repetições legítimas retornam o resultado original, sem reaplicar efeitos financeiros.
- Reutilizar uma chave com conteúdo diferente produz conflito.
- Restrições de unicidade no PostgreSQL protegem também contra requisições concorrentes.

Essas garantias são aplicadas pelo banco e pela camada de aplicação, sem depender exclusivamente das propriedades de ordenação ou deduplicação do SQS.

## 3. Arquitetura

A solução utiliza três processos executáveis separadamente:

- **API HTTP:** recebe requisições e executa operações financeiras.
- **SQS Consumer:** consome comandos, valida mensagens e utiliza o mesmo processamento financeiro da API.
- **Outbox Publisher:** publica eventos financeiros persistidos na Outbox.

Fluxo simplificado:

```text
                  +----------------------+
                  |    Provedores        |
                  +----------------------+
                         |        |
                      HTTP       SQS
                         |        |
                         v        v
                     +------+ +----------+
                     | API  | | Consumer |
                     +------+ +----------+
                         |        |
                         +---+----+
                             |
                             v
                   +--------------------+
                   | Processamento      |
                   | financeiro         |
                   +--------------------+
                             |
                             v
                   +--------------------+
                   | PostgreSQL         |
                   |                    |
                   | Wallets            |
                   | Wager Transactions |
                   | Immutable Ledger   |
                   | Inbox / Outbox     |
                   +--------------------+
                             |
                             v
                   +--------------------+
                   | Outbox Publisher   |
                   +--------------------+
                             |
                             v
                   +--------------------+
                   | SQS Events         |
                   +--------------------+
```

No processamento por SQS, **Inbox, transação financeira, carteira, ledger e Outbox participam do mesmo commit PostgreSQL**.

O consumidor confirma a mensagem no SQS somente depois do commit. O publisher publica eventos persistidos, confirma o envio e então registra o evento como publicado.

O publisher utiliza controle de concorrência com `FOR UPDATE SKIP LOCKED`, tokens de claim e leases, permitindo recuperação de trabalhos abandonados após falhas.

A publicação de eventos segue semântica **at-least-once**: uma falha entre o envio ao SQS e a confirmação no PostgreSQL pode produzir uma segunda publicação. Por isso, os eventos possuem identificadores estáveis para deduplicação pelos consumidores.

Mais detalhes em [ARCHITECTURE.md](ARCHITECTURE.md) e [infra/MESSAGING.md](infra/MESSAGING.md).

## 4. Tecnologias

| Componente | Tecnologia |
|---|---|
| Runtime e gerenciador de pacotes | Bun 1.x |
| Linguagem | TypeScript com modo `strict` |
| Framework HTTP | NestJS |
| Banco de dados | PostgreSQL 17 |
| Persistência e migrations | MikroORM 7 |
| Precisão monetária | decimal.js |
| Mensageria | AWS SQS — SDK v3 |
| Emulação local do SQS | MiniStack 1.5.36 |
| Infraestrutura local | Docker Compose |
| Testes | Bun Test |
| Análise estática | oxlint e TypeScript |

O TypeScript utiliza `strict`, mantendo a configuração `strictPropertyInitialization=false`, documentada entre as decisões da implementação.

### Organização do projeto

```text
.
├── README.md
├── ARCHITECTURE.md
├── backend/
│   ├── .env.example
│   ├── package.json
│   ├── bun.lock
│   ├── src/
│   │   ├── domain/
│   │   ├── application/
│   │   ├── api/
│   │   ├── infrastructure/
│   │   ├── workers/
│   │   └── migrations/
│   ├── test/
│   └── distributed-test/
└── infra/
    ├── compose.yaml
    ├── init-sqs.sh
    └── MESSAGING.md
```

As responsabilidades principais estão distribuídas entre domínio, serviços de aplicação, controllers HTTP, adaptadores de infraestrutura e processos de trabalho.

A persistência financeira utiliza SQL parametrizado executado dentro das transações gerenciadas pelo MikroORM.

## 5. Como executar

### 5.1. Pré-requisitos

É necessário ter:

- Bun 1.x disponível no `PATH` — validado com Bun 1.4.4.
- Node.js compatível com o Nest CLI — validado com Node.js 22.22.3.
- Docker e Docker Compose.
- Acesso autorizado ao daemon Docker.
- Portas `3000`, `5433` e `4566` disponíveis.

Não é necessária uma conta AWS nem credenciais pagas. A mensageria utiliza o MiniStack local.

### 5.2. Configurar o ambiente

Na raiz do repositório, copie o arquivo de exemplo, caso ainda não exista um `.env` local:

```bash
cp -n backend/.env.example backend/.env
```

Revise o conteúdo de `backend/.env` e ajuste as variáveis para o ambiente de desenvolvimento.

Os valores `change_me` são placeholders e devem ser substituídos por configurações locais apropriadas.

**Nunca versione o arquivo `.env` real.**

A API e os workers carregam a configuração a partir do diretório `backend`. O Docker Compose recebe o arquivo explicitamente com `--env-file`.

### 5.3. Iniciar PostgreSQL e MiniStack

Na raiz do repositório:

```bash
docker compose \
  --env-file backend/.env \
  -f infra/compose.yaml \
  config --quiet
```

Se a configuração estiver válida, inicie os serviços:

```bash
docker compose \
  --env-file backend/.env \
  -f infra/compose.yaml \
  up -d postgres ministack
```

Confira os containers:

```bash
docker compose \
  --env-file backend/.env \
  -f infra/compose.yaml \
  ps
```

Os volumes `postgres_data` e `sqs_data` preservam os dados entre reinicializações.

**Observação:** alterar a senha de um PostgreSQL já inicializado não modifica automaticamente as credenciais armazenadas no banco. Se estiver reutilizando um volume existente, mantenha as configurações compatíveis.

O Compose atual utiliza, como referência, o usuário `jungle` e o banco `jungle_wagering`.

### 5.4. Instalar dependências

Entre no diretório `backend`:

```bash
cd backend
bun install --frozen-lockfile
```

### 5.5. Inicializar as filas SQS

Ainda dentro de `backend`:

```bash
bun run queues:init
```

A infraestrutura utiliza quatro filas FIFO:

| Fila | Finalidade |
|---|---|
| `wager-transactions.fifo` | Recebimento dos comandos financeiros |
| `wager-transactions-dlq.fifo` | Dead Letter Queue dos comandos |
| `wager-events.fifo` | Publicação dos eventos da Outbox |
| `wager-events-dlq.fifo` | DLQ disponível para futuros consumidores de eventos |

O cliente SQS utiliza o endpoint local configurado por `SQS_ENDPOINT`, a região definida em `AWS_REGION` e credenciais fictícias de desenvolvimento.

A configuração rejeita endpoints AWS reais.

### 5.6. Preparar o banco de testes

O roteiro abaixo usa `jungle_wagering_test`, isolando os exemplos e as suítes de integração do banco principal de desenvolvimento.

O Compose inicializa `jungle_wagering`. Se o banco `jungle_wagering_test` ainda não existir, crie-o **uma única vez**, a partir da raiz do repositório:

```bash
docker compose \
  --env-file backend/.env \
  -f infra/compose.yaml \
  exec -T postgres \
  sh -c 'createdb -U "$POSTGRES_USER" jungle_wagering_test'
```

Se o banco já existir, não execute novamente esse comando.

Dentro de `backend`, aplique as migrations no banco de testes:

```bash
DB_NAME=jungle_wagering_test bun run db:migrate:test
```

Em seguida, compile o projeto:

```bash
bun run build
```

### Migrations

As migrations são versionadas:

| Migration | Responsabilidade |
|---|---|
| `Migration20261104000000` | Wallets, transações, ledger e constraints financeiras iniciais |
| `Migration20261104000001` | Integridade relacional do ledger e referências de reversões |
| `Migration20261104000002` | Inbox, Outbox, índices e constraints de mensageria |

As migrations não são aplicadas automaticamente durante a inicialização da API.

Para migração administrativa de outro banco configurado, existe também o comando do MikroORM:

```bash
bunx mikro-orm migration:up --config ./dist/mikro-orm.config.js
```

**Atenção:** esse último comando utiliza o banco selecionado pelas variáveis de ambiente. Confira o destino antes de executá-lo. Para os testes apresentados neste README, utilize o script específico de `jungle_wagering_test`.

## 6. Iniciar a aplicação

Após subir os containers, inicializar as filas, aplicar as migrations e compilar, execute os três processos em terminais separados.

Todos os comandos abaixo devem ser executados dentro de `backend`.

**Terminal 1 — API HTTP**

```bash
DB_NAME=jungle_wagering_test bun run start:prod
```

**Terminal 2 — SQS Consumer**

```bash
DB_NAME=jungle_wagering_test bun run start:consumer
```

**Terminal 3 — Outbox Publisher**

```bash
DB_NAME=jungle_wagering_test bun run start:publisher
```

A API utiliza a porta `3000` por padrão.

O consumidor processa comandos recebidos do SQS, enquanto o publisher entrega os eventos persistidos na Outbox.

Os workers implementam tratamento de sinais de encerramento, incluindo `SIGTERM` e `SIGINT`.

### Health checks

Com a API em execução:

```bash
curl -sS http://localhost:3000/health/live
curl -sS http://localhost:3000/health/ready
```

- `/health/live`: verifica se o processo está ativo.
- `/health/ready`: verifica as dependências necessárias, incluindo PostgreSQL e as filas SQS.

O endpoint de readiness pode retornar HTTP `503` quando uma dependência estiver indisponível.

**Importante:** esta implementação não possui autenticação. Execute a API em um ambiente local isolado, sem exposição pública.

## 7. API HTTP

### 7.1. Criar uma carteira

Com a API em execução, gere um identificador UUID para o jogador:

```bash
export PLAYER_ID="$(bun -e 'console.log(crypto.randomUUID())')"
```

Crie uma carteira com saldo inicial de `100.00 BRL`:

```bash
curl -sS -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d "{
    \"playerId\": \"$PLAYER_ID\",
    \"initialBalance\": {
      \"amount\": \"100.00\",
      \"currency\": \"BRL\"
    }
  }"
```

A resposta contém o identificador da carteira, o saldo e a versão.

A abertura com saldo positivo também registra uma operação interna `OPENING` e seu lançamento no ledger.

Copie o identificador retornado para a variável:

```bash
export WALLET_ID='substitua-pelo-id-retornado'
```

### 7.2. Registrar uma aposta (BET)

```bash
curl -sS -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo:bet-http-1' \
  -d "{
    \"providerId\": \"demo\",
    \"externalTransactionId\": \"bet-http-1\",
    \"playerId\": \"$PLAYER_ID\",
    \"walletId\": \"$WALLET_ID\",
    \"roundId\": \"round-1\",
    \"gameId\": \"game-1\",
    \"kind\": \"BET\",
    \"money\": {
      \"amount\": \"25.00\",
      \"currency\": \"BRL\"
    }
  }"
```

Para uma carteira nova com saldo inicial de `100.00 BRL`, a primeira aposta válida de `25.00 BRL` deixa o saldo em `75.00 BRL`.

Exemplo da estrutura de resposta:

```json
{
  "transactionId": "uuid-gerado-pelo-servidor",
  "status": "PROCESSED",
  "balance": {
    "amount": "75.00",
    "currency": "BRL"
  },
  "idempotentReplay": false,
  "failureCode": null
}
```

Repetir a mesma requisição, preservando a chave e o payload, retorna a resposta original com `idempotentReplay: true`, sem efetuar outro débito.

Para executar uma nova operação, utilize outra `Idempotency-Key` e outro `externalTransactionId`.

### 7.3. Demais operações

As operações `WIN`, `LOSS`, `REFUND` e `ROLLBACK` utilizam a mesma rota:

```text
POST /wagering/transactions
```

Altere o campo `kind` e informe identificadores únicos para cada nova operação.

Para `REFUND` e `ROLLBACK`, também é obrigatório fornecer:

```json
{
  "referenceExternalTransactionId": "bet-http-1"
}
```

Esse campo identifica a operação original dentro do mesmo provedor.

Regras relevantes:

- `WIN` credita saldo e pode referenciar uma `BET` da mesma rodada.
- `LOSS` registra o resultado sem alterar o saldo.
- `REFUND` exige uma `BET` processada e devolve seu valor integral.
- `ROLLBACK` inverte uma `BET`, `WIN` ou `REFUND` processada.
- Reversões não podem ser parciais.
- Cada referência pode receber no máximo uma reversão processada de cada tipo.
- Reversões que produziriam saldo negativo são rejeitadas sem alterar a carteira.

### 7.4. Respostas HTTP

| Situação | Status |
|---|---|
| Carteira criada | `201 Created` |
| Transação processada ou replay | `200 OK` |
| Referência ainda não encontrada | `202 Accepted` |
| Payload inválido | `400 Bad Request` |
| Carteira não encontrada | `404 Not Found` |
| Conflito de idempotência ou identidade da carteira | `409 Conflict` |
| Rejeição financeira persistida | `422 Unprocessable Entity` |
| Falha inesperada ou de infraestrutura não tratada | `500 Internal Server Error` |

Rejeições financeiras persistidas possuem `failureCode` para permitir identificação programática da causa.

## 8. Processamento por SQS

Além da API HTTP, o sistema aceita comandos financeiros através da fila `wager-transactions.fifo`.

O consumidor utiliza o mesmo processamento financeiro da API, com validações, idempotência e atomicidade transacional.

### Exemplo de mensagem

```json
{
  "messageId": "uuid-da-mensagem",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-04T20:00:00.000Z",
  "data": {
    "providerId": "demo",
    "externalTransactionId": "bet-sqs-1",
    "idempotencyKey": "demo:bet-sqs-1",
    "playerId": "uuid-do-jogador",
    "walletId": "uuid-da-carteira",
    "roundId": "round-sqs-1",
    "gameId": "game-1",
    "kind": "BET",
    "money": {
      "amount": "10.00",
      "currency": "BRL"
    }
  }
}
```

### Enviar uma mensagem sem AWS CLI

Com `PLAYER_ID` e `WALLET_ID` exportados no terminal e dentro do diretório `backend`:

```bash
bun -e '
import "dotenv/config";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  createSqsClient,
  resolveQueues
} from "./src/infrastructure/sqs/sqs-config.ts";

const client = createSqsClient();

try {
  const queues = await resolveQueues(client);
  const id = crypto.randomUUID();

  const message = {
    messageId: id,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "demo",
      externalTransactionId: `bet-sqs-${id}`,
      idempotencyKey: `demo:${id}`,
      playerId: process.env.PLAYER_ID,
      walletId: process.env.WALLET_ID,
      roundId: "round-2",
      gameId: "game-1",
      kind: "BET",
      money: {
        amount: "10.00",
        currency: "BRL"
      }
    }
  };

  await client.send(new SendMessageCommand({
    QueueUrl: queues.commands,
    MessageBody: JSON.stringify(message),
    MessageGroupId: process.env.WALLET_ID,
    MessageDeduplicationId: id
  }));

  console.log("Comando enviado ao MiniStack");
} finally {
  client.destroy();
}
'
```

O consumidor processa a mensagem e registra o resultado no PostgreSQL.

O publisher envia os eventos confirmados para `wager-events.fifo`, uma fila separada daquela utilizada para comandos financeiros.

Não há consumidor de projeções ou de eventos downstream nesta entrega.

### Inbox e Outbox

O processamento utiliza dois mecanismos complementares.

**Inbox**

- Registra a identidade das mensagens recebidas.
- Deduplica entregas repetidas.
- Detecta reutilização de `messageId` com conteúdo divergente.
- Participa da mesma transação SQL da operação financeira.
- Permite confirmação da mensagem somente depois do commit.

**Transactional Outbox**

- Registra eventos de integração junto com a operação financeira.
- Publica eventos de forma assíncrona após o commit.
- Utiliza claims, leases e `SKIP LOCKED` para concorrência entre publishers.
- Implementa tentativas de republicação e recuperação de claims abandonados.
- Preserva identificadores estáveis de eventos.

Eventos suportados incluem:

- `WagerTransactionProcessed`
- `WagerTransactionRejected`
- `WalletBalanceChanged`
- `WagerTransactionPendingReference`

A infraestrutura utiliza semântica *at-least-once*. Consumidores futuros da fila de eventos devem implementar deduplicação pelo identificador do evento e considerar possíveis diferenças de ordem entre publicações.

## 9. Testes e validação

O projeto utiliza Bun Test para testes unitários, de integração e distribuídos.

A validação foi realizada com PostgreSQL real e MiniStack em containers, sem substituí-los integralmente por mocks.

### Executar a suíte

Dentro do diretório `backend`, com os containers e migrations disponíveis:

```bash
bun run build
bun run test
DB_NAME=jungle_wagering_test bun run test:e2e
DB_NAME=jungle_wagering_test bun run test:distributed
bun run lint
bunx tsc --noEmit --incremental false
```

Os testes de integração devem ser executados exclusivamente contra `jungle_wagering_test`.

A suíte distribuída utiliza schemas e filas próprios e pode preservar registros de auditoria entre execuções. Não é necessário apagar volumes para executá-la.

### Resultados da última validação

| Categoria | Testes aprovados |
|---|---:|
| Testes unitários | 88 |
| Integração e E2E PostgreSQL | 122 |
| Testes distribuídos com MiniStack | 20 |
| **Total** | **230** |

Na última execução reportada:

- Build aprovado.
- 230 testes aprovados, sem falhas.
- Lint sem erros ou avisos.
- Verificação de tipos TypeScript aprovada.

### Cenários exercitados

Entre os cenários cobertos pelos testes estão:

- Precisão monetária, valores inválidos e overflow.
- Regras de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- Saldo insuficiente e reversões rejeitadas.
- Imutabilidade e integridade do ledger.
- Replay idempotente e conflitos de payload.
- Concorrência sobre a mesma carteira.
- Processamento concorrente em três processos independentes.
- Recebimento e redelivery de mensagens SQS.
- Deduplicação por Inbox persistente.
- Rollback integral quando a persistência do ledger ou da Outbox falha.
- Rejeições financeiras com resposta auditável.
- Retry e encaminhamento para a DLQ.
- Publishers concorrentes.
- Recuperação após falhas de processo em cenários específicos.
- Encerramento controlado dos workers com `SIGTERM`.

Os testes demonstram os comportamentos exercitados nos cenários implementados. Não representam uma garantia de ausência de falhas em todas as condições possíveis de produção.

## 10. Escopo e limitações

Esta implementação prioriza a correção financeira, idempotência persistente e execução distribuída. Algumas partes do edital permanecem parciais ou fora do escopo entregue.

| Requisito | Situação | Observações |
|---|---|---|
| Precisão monetária e saldo não negativo | Implementado | Money com decimal.js e constraints PostgreSQL |
| Ledger imutável | Implementado | Lançamentos persistidos com restrições no banco |
| OPENING, BET, WIN, LOSS, REFUND e ROLLBACK | Implementado | Operações com referências disponíveis podem ser concluídas imediatamente |
| Idempotência e concorrência | Implementado | Garantias persistidas e controle por wallet |
| SQS, Inbox e Outbox | Implementado | Processamento at-least-once e recuperação de workers |
| Referências fora de ordem | Parcial | `PENDING_REFERENCE` é persistido, sem worker de resolução automática |
| Modelagem orientada a domínio | Parcial | Value Objects, entidades e eventos; parte das decisões permanece nos serviços SQL |
| Observabilidade | Parcial | Health checks e logs básicos; métricas e correlação completa não implementadas |
| Consultas financeiras HTTP | Não implementado | Consultas de carteira, transações e extrato |
| Reconciliação HTTP | Não implementado | Endpoint de comparação entre saldo materializado e ledger |
| Autenticação | Não implementado | Decisão e proposta de integração descritas em ARCHITECTURE.md |

### Decisões e trade-offs

**Referências pendentes**

O sistema registra referências não encontradas como `PENDING_REFERENCE`, preservando a operação para auditoria, sem movimentar saldo. Ainda não existe um worker que tente resolver automaticamente essas dependências com backoff e TTL.

**Mensageria**

A publicação da Outbox oferece recuperação e entrega *at-least-once*, não *exactly-once* no broker. Duplicações possíveis após falhas de publicação precisam ser tratadas pelos consumidores downstream.

**Ordenação**

Publishers concorrentes podem publicar eventos de uma mesma carteira fora da ordem original. Os eventos de alteração de saldo carregam a versão da wallet, representada como string para preservar a precisão do `BIGINT`.

**Autenticação**

A API foi mantida sem autenticação para concentrar o desenvolvimento nas invariantes financeiras e distribuídas. Uma evolução para produção exigiria integração com um Identity Provider, autenticação dos provedores e autorização por escopo.

**Observabilidade**

A implementação dispõe de health checks, mas não inclui toda a instrumentação de métricas, logs estruturados com correlação completa e dashboards necessária para operação em produção.

**Ambiente**

Os testes foram executados com infraestrutura local real. A reprodução integral em uma máquina limpa e independente não foi validada como parte da última execução reportada.

Essas limitações são conhecidas e não devem ser interpretadas como funcionalidades concluídas.

## 11. Documentação adicional

- [ARCHITECTURE.md](ARCHITECTURE.md) — arquitetura, decisões técnicas, fronteiras transacionais, concorrência, idempotência e trade-offs.
- [infra/MESSAGING.md](infra/MESSAGING.md) — filas, infraestrutura SQS, workers, comandos de operação e testes de mensageria.
- [Desafio original — Jungle Gaming](https://github.com/junglegaming/backend-challenge) — especificação e critérios de avaliação.

---

Projeto desenvolvido como solução para o desafio técnico **Distributed Wagering Processor — Jungle Gaming**.
