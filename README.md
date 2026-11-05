# Jungle Gaming — Distributed Wagering Processor

Implementação do [desafio Backend da Jungle Gaming](https://github.com/junglegaming/backend-challenge).
A entrega cobre o processamento financeiro HTTP/SQS com PostgreSQL como autoridade.
**Não implementa integralmente o edital**: veja a matriz e [ARCHITECTURE.md](ARCHITECTURE.md).

## Tecnologias e organização

Bun 1.x, TypeScript strict/ESM, NestJS, PostgreSQL 17, MikroORM 7, decimal.js,
AWS SDK v3 e MiniStack 1.5.36. API, consumidor e publisher são processos separados.
`backend/src/domain` contém VOs, entidades e eventos; `application`, serviços e
Inbox; `api`, controllers; `infrastructure`, adapters SQS/Outbox; `workers`, entrypoints.
A persistência financeira usa SQL parametrizado nas transações do MikroORM.

## Pré-requisitos

- Bun 1.x no PATH (validado com 1.4.4).
- Node.js compatível com o Nest CLI (validado com 22.22.3).
- Docker e Docker Compose com acesso autorizado ao daemon.
- Portas locais 5433, 4566 e 3000 disponíveis; curl para os exemplos.
- Não é necessária conta AWS, AWS CLI ou credencial paga.

## Ambiente e infraestrutura

Na raiz, copie o exemplo **somente se o arquivo local ainda não existir**:

```sh
cp -n backend/.env.example backend/.env
```

Edite `.env` localmente. `change_me` é um placeholder: escolha uma senha de
desenvolvimento e nunca versione o arquivo real. Aplicação e workers carregam
`.env` a partir de `backend`; o Compose recebe esse arquivo explicitamente:

```sh
docker compose --env-file backend/.env -f infra/compose.yaml config --quiet
docker compose --env-file backend/.env -f infra/compose.yaml up -d postgres ministack
docker compose --env-file backend/.env -f infra/compose.yaml ps
```

Os volumes `postgres_data` e `sqs_data` preservam estado; não precisam ser apagados.
Alterar a senha no arquivo não altera a senha de um PostgreSQL já inicializado:
preserve as configurações compatíveis com seu volume existente. O healthcheck
atual do Compose pressupõe o usuário `jungle` e o banco `jungle_wagering` do exemplo.

O hook cria quatro filas FIFO distintas:

| Fila | Uso |
| --- | --- |
| wager-transactions.fifo | Comandos financeiros |
| wager-transactions-dlq.fifo | DLQ dos comandos |
| wager-events.fifo | Eventos da Outbox |
| wager-events-dlq.fifo | DLQ disponível para consumidores de eventos futuros |

O SDK usa credenciais fictícias fixas `test/test`, endpoint local `SQS_ENDPOINT`
e região `AWS_REGION`. Endpoint AWS real é rejeitado. Defaults em `.env.example`.
Para instalar as dependências travadas e repetir a inicialização sem apagar mensagens:

```sh
cd backend
bun install --frozen-lockfile
bun run queues:init
```

## Banco de avaliação e migrations

Este roteiro executa API, workers e testes em **jungle_wagering_test**. O Compose
cria inicialmente `jungle_wagering`. Crie o banco de teste uma única vez, na raiz,
**se ele ainda não existir**; caso contrário, pule esse comando:

```sh
docker compose --env-file backend/.env -f infra/compose.yaml exec -T postgres \
  sh -c 'createdb -U "$POSTGRES_USER" jungle_wagering_test'
```

Dentro de `backend`:

```sh
DB_NAME=jungle_wagering_test bun run db:migrate:test
bun run build
```

O script recusa outro DB_NAME. As migrations têm up/down:

| Migration | Conteúdo |
| --- | --- |
| Migration20261104000000 | Wallets, transações, ledger e constraints iniciais |
| Migration20261104000001 | Integridade composta do ledger e referências de reversões |
| Migration20261104000002 | Inbox, Outbox, índices e constraints de mensageria |

Não há migration automática no startup. Para uma instalação separada no banco
selecionado pelo ambiente, o CLI existente também permite, após build:

```sh
bunx mikro-orm migration:up --config ./dist/mikro-orm.config.js
```

Esse último comando migra o banco selecionado por DB_NAME/.env: revise o destino.
A preparação da entrega não aplica migrations no banco principal.

## Executar API, consumidor e publisher

Depois de inicializar filas, aplicar migrations e compilar, em três terminais,
sempre a partir de `backend`:

```sh
# Terminal 1
DB_NAME=jungle_wagering_test bun run start:prod
# Terminal 2
DB_NAME=jungle_wagering_test bun run start:consumer
# Terminal 3
DB_NAME=jungle_wagering_test bun run start:publisher
```

`bun run start` compila antes da API; `start:dev` existe para watch. PORT padrão: 3000.
SIGTERM/SIGINT solicitam shutdown dos workers. Não há worker de referências pendentes.

```sh
curl -sS http://localhost:3000/health/live
curl -sS http://localhost:3000/health/ready
```

Readiness exige PostgreSQL e as quatro filas acessíveis e pode retornar 503.
**A API não tem autenticação: use em ambiente local isolado.**

## Exemplos HTTP

Com API no banco de avaliação, dentro de `backend`, gere um player por demonstração:

```sh
export PLAYER_ID="$(bun -e 'console.log(crypto.randomUUID())')"
curl -sS -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
```

Copie o `id` retornado para WALLET_ID:

```sh
export WALLET_ID='substitua-pelo-id-retornado'
curl -sS -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo:bet-http-1' \
  -d "{\"providerId\":\"demo\",\"externalTransactionId\":\"bet-http-1\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

Resposta inicial esperada: status PROCESSED, balance.amount "75.00",
idempotentReplay false, failureCode null e transactionId gerado. Repetir o mesmo
comando retorna o resultado original com replay verdadeiro. Use chaves e referências
externas novas em demonstrações independentes.

WIN/LOSS usam a mesma rota, alterando kind, chave e referência externa. REFUND e
ROLLBACK exigem referenceExternalTransactionId, valor integral e escopo compatível
com a referência. OPENING é interno. Valores monetários são strings de escala 2,
BRL ou USD; todas as operações externas exigem valor positivo, inclusive LOSS.

| Situação | HTTP |
| --- | --- |
| Wallet criada | 201 |
| Operação processada ou replay | 200 |
| Referência ausente | 202 |
| Payload inválido | 400 |
| Wallet inexistente | 404 |
| Idempotência, wallet incompatível ou wallet duplicada | 409 |
| Rejeição financeira persistida | 422 |
| Falha SQL/inesperada na operação | 500 padrão NestJS |

## Exemplo SQS sem AWS CLI

Com os mesmos PLAYER_ID e WALLET_ID exportados, dentro de `backend`:

```sh
bun -e '
import "dotenv/config";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { createSqsClient, resolveQueues } from "./src/infrastructure/sqs/sqs-config.ts";
const client = createSqsClient();
try {
  const queues = await resolveQueues(client);
  const id = crypto.randomUUID();
  const message = {
    messageId: id, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(),
    data: {
      providerId: "demo", externalTransactionId: `bet-sqs-${id}`, idempotencyKey: `demo:${id}`,
      playerId: process.env.PLAYER_ID, walletId: process.env.WALLET_ID,
      roundId: "round-2", gameId: "game-1", kind: "BET",
      money: { amount: "10.00", currency: "BRL" }
    }
  };
  await client.send(new SendMessageCommand({
    QueueUrl: queues.commands, MessageBody: JSON.stringify(message),
    MessageGroupId: process.env.WALLET_ID, MessageDeduplicationId: id
  }));
  console.log("Comando enviado ao MiniStack");
} finally { client.destroy(); }
'
```

O consumidor grava a Inbox e executa o mesmo caso de uso HTTP. O publisher envia
eventos à fila de eventos; ela não alimenta o consumidor financeiro. Não existe
consumidor de projeções/eventos nesta entrega.

## Validação

Em `backend`, com dependências, migrations, PostgreSQL e MiniStack disponíveis:

```sh
bun run build
bun run test
DB_NAME=jungle_wagering_test bun run test:e2e
DB_NAME=jungle_wagering_test bun run test:distributed
bun run lint
bunx tsc --noEmit --incremental false
git diff --check
```

Nunca execute suítes PostgreSQL contra o banco principal. As de mensageria criam
schemas e filas exclusivos e preservam dados de auditoria: execuções repetidas
acumulam dados de teste. SQS real é obrigatório; indisponibilidade falha a suíte,
sem fallback para mocks. TypeScript usa strict com a exceção existente
strictPropertyInitialization=false. Resultados: [validação](ARCHITECTURE.md#validação-da-entrega).

## Matriz da entrega

| Requisito | Estado | Limite |
| --- | --- | --- |
| Money, saldo, ledger e constraints | Implementado | BRL/USD, escala 2 |
| OPENING, BET, WIN, LOSS, REFUND, ROLLBACK | Implementado | Referências disponíveis permitem conclusão imediata |
| Idempotência e concorrência distribuída | Implementado | PostgreSQL como autoridade |
| SQS, Inbox, Outbox e recuperação de workers | Implementado | Publicação at-least-once |
| Referências fora de ordem | Parcial | PENDING_REFERENCE; sem resolução, backoff/TTL ou conclusão posterior |
| Modelagem DDD | Parcial | VOs/entidades/eventos; decisões financeiras nos serviços SQL |
| Observabilidade | Parcial | Health e logs básicos; faltam métricas e contexto completo |
| Consultas HTTP e reconciliação | Ausente | GETs financeiros e endpoint de reconciliação |
| Autenticação e ponto de extensão dedicado | Ausente | Desenho documentado, sem Guard/port implementado |

Detalhes: [ARCHITECTURE.md](ARCHITECTURE.md) e [infra/MESSAGING.md](infra/MESSAGING.md).

## Checklist antes de publicar

- [ ] Revisar o diff completo, incluindo os arquivos novos de mensageria da etapa anterior.
- [ ] Incluir as três migrations, scripts, lockfile e documentação na entrega revisada.
- [ ] Conferir que .env, credenciais, dumps, volumes, node_modules e dist não serão adicionados.
- [ ] Executar um scanner de segredos no histórico Git antes de tornar o repositório público.
- [ ] Reproduzir o roteiro em ambiente limpo com bancos/volumes novos separados dos existentes.
- [ ] Informar ao avaliador as lacunas da matriz, sem declarar conformidade integral.

A preparação não faz commit, push, publicação ou remoção de volumes. Os testes
não equivalem a uma instalação do zero comprovada em outra máquina.
