# Mensageria local

MiniStack é executado sem conta AWS, token pago ou montagem do socket Docker.
O PostgreSQL e o volume `postgres_data` existentes permanecem na configuração original.
O volume novo `sqs_data` guarda o estado do emulador entre reinícios normais.

Na raiz do repositório:

```sh
docker compose --env-file backend/.env -f infra/compose.yaml config --quiet
docker compose --env-file backend/.env -f infra/compose.yaml up -d ministack
```

O hook `init-sqs.sh` cria/configura quatro filas FIFO:

| Fila | Finalidade |
| --- | --- |
| `wager-transactions.fifo` | Entrada de comandos financeiros |
| `wager-transactions-dlq.fifo` | Comandos inválidos ou com tentativas esgotadas |
| `wager-events.fifo` | Saída dos eventos da Outbox |
| `wager-events-dlq.fifo` | Recuperação de futuros consumidores de eventos |

Visibility timeout de 60 segundos, máximo de cinco recebimentos antes do redrive,
retenção de quatro dias na origem e 14 dias nas DLQs. Os workers não consomem
a fila de eventos. O inicializador não apaga mensagens e pode ser repetido:

```sh
cd backend
bun run queues:init
```

`SQS_ENDPOINT` permite `localhost`, loopback, `localstack`, `ministack` e
`host.docker.internal`. O cliente sempre usa credenciais fictícias `test/test`.
As quatro variáveis `SQS_*_QUEUE`/`SQS_*_DLQ` estão em `.env.example`.
Nomes e URLs devem ser distintos. O endpoint nunca é inferido de credenciais AWS.

## Validação e execução isolada

O banco de teste deve existir previamente. Nenhum comando abaixo cria, limpa
ou recria o banco principal. A migration nova precisa estar aplicada antes de
executar a versão nova da API, pois a Outbox participa dos commits financeiros.

```sh
cd backend # a partir da raiz do repositório
DB_NAME=jungle_wagering_test bun run db:migrate:test
bun run build
DB_NAME=jungle_wagering_test bun run test:e2e
DB_NAME=jungle_wagering_test bun run test:distributed
bun run test
bun run lint
git diff --check
```

Em três terminais separados, depois do build e da inicialização das filas:

```sh
DB_NAME=jungle_wagering_test bun run start:prod
DB_NAME=jungle_wagering_test bun run start:consumer
DB_NAME=jungle_wagering_test bun run start:publisher
```

Os testes novos de mensageria criam schemas exclusivos dentro de
`jungle_wagering_test` e filas com prefixo `jt-<uuid>`. Esses dados de auditoria
ficam preservados: a suíte não usa truncate, purge ou exclusão de dados financeiros.
Também não regrava os snapshots de schema versionados durante esses testes.
A suíte distribuída falha no setup quando o SQS real não está disponível;
não há fallback para mocks nem skip automático.

## Fronteiras e recuperação

HTTP abre a transação SQL no `BettingService`. O consumidor abre uma transação
externa e chama `submitTransactionInTransaction`, que não abre uma segunda
transação. Inbox, decisão financeira, wallet, ledger, resposta original e
Outbox confirmam juntos. O consumidor só remove a mensagem depois desse commit.
O timeout total da transação do consumidor é de 20 segundos no PostgreSQL 17,
inferior ao visibility timeout. O lock continua sendo por wallet.

A Inbox usa o `messageId` do envelope, não o ID gerado pelo SQS. Seu hash cobre
o envelope JSON completo com chaves ordenadas recursivamente. A idempotência
financeira mantém seu algoritmo anterior, independente do transporte e com
UUIDs normalizados. Um novo envelope da mesma operação pode completar outra
Inbox sem gerar novo efeito financeiro ou novos eventos.

Rejeições financeiras e referências pendentes são persistidas e recebem ack.
Payloads inválidos, conflito de Inbox ou idempotência e wallet incompatível são
encaminhados à DLQ antes do ack. Falhas SQL, de rede e de confirmação mantêm a
mensagem recuperável; o backoff é limitado e o broker limita os recebimentos.

Eventos usam subclasses de `IntegrationEvent`, versão 1 e dinheiro em strings.
`WalletBalanceChanged.data.walletVersion` também é string para representar
exatamente o BIGINT do PostgreSQL. OPENING positivo gera os eventos de transação
processada e saldo alterado; abertura com zero não gera movimentação ou evento.
Replays não criam eventos. Eventos históricos anteriores à migration não são
reconstruídos automaticamente.

O publisher faz claim de um evento por vez em uma transação curta com
`FOR UPDATE SKIP LOCKED`, token e lease de 60 segundos. O envio ocorre depois
do commit do claim. Só a confirmação do SQS permite preencher `published_at`;
updates são condicionados ao token. Erros agendam backoff persistente de até
uma hora; crashes deixam um lease que outra instância pode recuperar.

Uma queda entre envio e confirmação SQL pode repetir a publicação. O ID do
evento persiste e é usado como `MessageDeduplicationId`. A janela de deduplicação
FIFO é finita; consumidores downstream ainda precisam de Inbox por `eventId`.
Publishers concorrentes não garantem a ordem original dos eventos de uma wallet;
consumidores de projeções devem usar a versão da wallet para lidar com reordenação.

SIGINT/SIGTERM interrompem o próximo poll e aguardam o trabalho em andamento.
Em falha durante shutdown, o consumidor tenta devolver a visibilidade; se o
processo for morto, a visibilidade ou o lease expiram. Nenhuma garantia depende
de estado em memória. Workers de referências pendentes ficam fora desta etapa.

## Inventário desta etapa

Arquivos existentes alterados:

```text
backend/.env.example
backend/bun.lock
backend/package.json
backend/src/api/wagering.controller.ts
backend/src/application/services/betting.service.ts
backend/src/application/services/wallets.service.ts
backend/src/health.controller.ts
backend/src/main.ts
infra/compose.yaml
```

Arquivos novos:

```text
backend/src/migrations/Migration20261104000002.ts
backend/src/application/messaging/inbox-processor.ts
backend/src/application/messaging/parse-wager-command.ts
backend/src/application/messaging/wager-request.ts
backend/src/application/messaging/wager-request.spec.ts
backend/src/application/messaging/write-events.ts
backend/src/domain/events/integration-event.ts
backend/src/domain/events/integration-event.spec.ts
backend/src/infrastructure/outbox/outbox-publisher.ts
backend/src/infrastructure/sqs/init-queues.ts
backend/src/infrastructure/sqs/sqs-config.ts
backend/src/infrastructure/sqs/wager-consumer.ts
backend/src/workers/consumer.ts
backend/src/workers/init-queues.ts
backend/src/workers/migrate-test.ts
backend/src/workers/publisher.ts
backend/src/workers/runtime.ts
backend/test/messaging-atomicity.spec.ts
backend/test/support/messaging.ts
backend/distributed-test/messaging.spec.ts
backend/distributed-test/support/sqs.ts
backend/distributed-test/support/worker-process.ts
infra/init-sqs.sh
infra/MESSAGING.md
```
