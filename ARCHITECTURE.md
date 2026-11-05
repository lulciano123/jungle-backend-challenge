# Arquitetura e limites da entrega

## Decisões e fronteiras

A referência é o [edital oficial](https://github.com/junglegaming/backend-challenge).
O código é a fonte de verdade; a matriz do README não declara conformidade integral.

NestJS expõe HTTP; Bun executa aplicação e testes. MikroORM fornece configuração,
pool, migrations e EntityManager.transactional(). O caminho financeiro usa SQL
parametrizado explícito, tornando locks e constraints visíveis. Não há entidades
de persistência mapeadas: entities está vazio; Identity Map/Unit of Work não
materializam saldo. O custo é concentrar domínio e persistência nos serviços.

Money, Wallet, WalletLedgerEntry e eventos têm factories e encapsulamento.
O serviço financeiro trabalha com rows SQL e Money, sem reidratar os agregados
para todas as transições. WagerTransaction, Inbox e Outbox não têm as entidades
de domínio completas exemplificadas no edital. A modelagem DDD é parcial.
API, consumidor e publisher são processos independentes; workers inicializam
MikroORM diretamente. BettingService é o caso de uso comum, apesar do nome histórico.

## Dinheiro e ledger

Money usa clone isolado de decimal.js, precisão 40, campo privado e objeto
congelado. Entrada/saída são strings com duas casas, BRL/USD, limitadas ao teto
NUMERIC(20,2): 999999999999999999.99. Rejeita notação científica, negativos na
entrada, NaN/Infinity e formatos inválidos. Operações retornam novas instâncias;
negativos internos são permitidos para deltas, sem entrar nos contratos externos.
O SQL lê NUMERIC como texto para reconstruir Money; dinheiro não passa por number.
A versão BIGINT da wallet é string nos eventos para preservar sua precisão.

Saldo inicial positivo gera OPENING e CREDIT atomicamente; zero não gera movimento.
Versão começa em 1. BET debita, WIN credita, LOSS registra sem saldo, ledger ou
incremento. Todas as operações externas exigem valor positivo, inclusive LOSS.
REFUND credita BET processada; ROLLBACK inverte BET, WIN ou REFUND processada.
Referências são resolvidas por provider + externalTransactionId, com igualdade
de player, wallet, moeda, rodada e valor integral nas reversões. GameId não precisa
ser igual. WIN com referência opcional valida BET e escopo, sem exigir valor igual,
jogo igual ou status PROCESSED da BET. São as regras efetivas do serviço.

Triggers bloqueiam UPDATE, DELETE e TRUNCATE do ledger. Constraints validam
aritmética, limites, direção, unicidade por transação/wallet e FKs compostas.
Saldo e ledger são gravados juntos pelo serviço; não há trigger geral que compare
a wallet com toda a soma do ledger após qualquer SQL arbitrário. Escritores
externos com privilégios amplos podem violar essa consistência global. Não há
reconciliador/endpoint em produção; os testes comparam saldo e reconstrução.

## Concorrência e idempotência

SELECT FOR UPDATE bloqueia a wallet durante decisão e gravação, sem lock global.
UPDATE usa delta NUMERIC, incrementa versão e verifica não-negatividade. Wallets
distintas têm locks distintos. O custo é serializar uma wallet muito disputada;
não há benchmark de throughput. A versão não é usada como optimistic locking.

SHA-256 cobre JSON de campos inseridos em ordem alfabética: amount normalizado,
currency, externalTransactionId, gameId, kind, playerId, providerId, referência
quando aplicável/presente, roundId e walletId. UUIDs são normalizados para
minúsculas; IDs textuais preservam capitalização. Header e transporte ficam fora.

Há unicidade global de Idempotency-Key e de provider + referência externa.
O serviço consulta ambas: só mesma chave e mesmo payload são replay, sem aliases
implícitos. Colisões cruzadas conflitam. A original_response persiste a resposta,
inclusive saldo original, mesmo após novas movimentações. Replay não gera eventos
nem ledger. Não existe cache em memória como garantia de idempotência.

O índice parcial (reference_transaction_id, kind) limita reversão PROCESSED por
tipo. REFUND e ROLLBACK podem reverter a mesma BET uma vez cada, de acordo com
esse escopo; não foi introduzida proibição cruzada adicional.

## Atomicidade e Inbox

HTTP abre a transação financeira. O consumidor abre uma transação externa e
chama submitTransactionInTransaction, que exige transação ativa e não faz commit
independente. Inbox, decisão/response, saldo, ledger e Outbox confirmam juntos.
Falha de INSERT ou na finalização da Inbox reverte tudo. Ack vem depois do commit;
queda nesse intervalo provoca replay, não uma nova movimentação.

Inbox usa (consumer_name, message_id), sendo messageId o ID do envelope, não o ID
do broker. SHA-256 cobre o envelope completo com chaves ordenadas recursivamente.
Mesmo ID com conteúdo diferente é conflito. Um novo envelope de operação já
confirmada por HTTP completa Inbox por idempotência financeira. Os hashes de
Inbox e da operação financeira têm escopos diferentes intencionalmente.

Referência ausente grava PENDING_REFERENCE, resposta e evento, sem saldo/ledger.
A mensagem recebe ack, mas **não existe conclusão automática posterior**:
chegada da referência ou replay não resolve a pendência. Não há TTL/tentativas
implementados para essa resolução. PENDING/FAILED existem no schema, sem fluxo
completo de transições de domínio ou FAILED para toda falha permanente.

Rejeições de negócio persistidas recebem ack. Payload inválido, conflitos e wallet
inválida seguem à DLQ antes da remoção da origem. Erros SQL/rede sofrem retry
com backoff e redrive depois do limite configurado de cinco recebimentos.
Códigos financeiros: INSUFFICIENT_FUNDS, REVERSAL_INSUFFICIENT_FUNDS,
BALANCE_LIMIT_EXCEEDED, INVALID_REFERENCE_KIND, REFERENCE_MISMATCH,
REFERENCE_NOT_PROCESSED, REFERENCE_AMOUNT_MISMATCH e REFERENCE_ALREADY_REVERSED.
IDEMPOTENCY_CONFLICT é conflito de entrada; INBOX_PAYLOAD_CONFLICT distingue
reutilização de messageId. Não são tratados como rejeição por falta de saldo.

## Outbox, eventos e recuperação

IntegrationEvent é abstrata, com subclasses concretas e versão 1. Envelope tem
eventId, aggregateId da wallet, correlationId, causationId opcional, occurredAt
e DTOs de dinheiro. Dados são copiados/congelados. Tipos: WagerTransactionProcessed,
WagerTransactionRejected, WalletBalanceChanged e WagerTransactionPendingReference.
OPENING positivo também gera eventos. Não há backfill de transações históricas.

O publisher faz claim de um evento com SKIP LOCKED, token e lease de 60s. A
transação curta termina antes do envio SQS. Confirmação do broker precede a
marcação publicada, condicionada ao token. Erros agendam backoff persistente de
até uma hora; não há limite terminal de tentativas do publisher ou alerta automático.
Crashes permitem reclaim após expiração. Uma queda depois do envio e antes da
confirmação SQL pode duplicar publicação: eventId permanece estável e serve como
deduplicationId FIFO. A janela FIFO é finita; consumidores downstream precisam
de Inbox por eventId e não existem nesta entrega. Publishers concorrentes podem
reordenar eventos; a versão ajuda projeções de saldo a detectar atrasos.

Comandos e eventos têm filas separadas, sem ciclo. MiniStack atende apenas uso
local; a configuração explicitamente não suporta implantação AWS real. Persistência
do emulador não substitui backups ou durabilidade de um serviço gerenciado.

Consumidor: lock timeout 5s, statement timeout 15s e transaction timeout 20s
(PostgreSQL 17), abaixo da visibilidade de 60s. SIGTERM/SIGINT interrompem novos
polls e aguardam operações. Se morrer ou falhar ao devolver visibilidade, a
expiração permite redelivery. Indisponibilidade no startup pode encerrar workers;
não há supervisor automático incluído. Depois do startup, os loops fazem retry.
Não há autoscaling ou painel de recuperação de DLQ.

## Autenticação: decisão e desenho proposto, não implementado

Foi priorizada correção financeira local. Não há autenticação, autorização,
rate limiting ou vínculo autenticado de providerId a principal; IDs vêm da entrada.
A API não está pronta para exposição pública.

O desenho usaria IdP externo OIDC, como Keycloak, e Guard NestJS validando issuer,
audience, assinatura e expiração antes dos controllers. Uma ProviderIdentityPort
na camada de aplicação vincularia principal a providerId. Health continuaria
público; SQS manteria validação de domínio. Isso é proposta: não há Guard/no-op
ou port dedicado no código. O ponto de extensão pedido no edital permanece ausente.
Nenhuma credencial real pertence aos exemplos; o SDK local usa test/test fixos.

## Observabilidade e fora do escopo

Health live/ready existe; ready consulta PostgreSQL e filas. Logs JSON dos workers
são básicos: faltam contexto completo de correlação em todos os fluxos e métricas
de status, duplicatas, retries, DLQ, locks, lag e latência. Falhas SQL/inesperadas
HTTP usam 500 padrão NestJS, sem taxonomia completa de indisponibilidade transitória.
Não há tracing, dashboards ou alertas.

Ausentes: GETs financeiros, paginação de ledger, reconciliação, worker de referências,
consumidor downstream, ledger de partidas dobradas, teste de carga, CI e desenho
completo de produção/backup/retenção. Algumas ausências são requisitos obrigatórios
pendentes; partidas dobradas e carga são opcionais. O down das migrations existe,
mas não foi executado nesta preparação. Não se classificam essas ausências como
bugs comprovados das operações atuais.

## Validação da entrega

Validação executada em 2026-11-04. Os testes usam
jungle_wagering_test e MiniStack local. Preservam schemas/filas exclusivos;
cobrem triggers de falha reais, HTTP seguido de SQS, redelivery, DLQ, processos
concorrentes, SIGKILL e SIGTERM. Leases são antecipados nos testes, sem esperar
60s. Não foram comprovados reinício forçado do container, partição prolongada,
duplicação após janela FIFO ou SIGINT específico. Testes aprovados não comprovam
todas as garantias nem conformidade integral. TypeScript strict está habilitado,
com strictPropertyInitialization=false e skipLibCheck=true no projeto existente.


| Validação executada | Resultado |
| --- | --- |
| bun run build | Aprovado |
| bun run test | 88 aprovados, 0 falhas |
| DB_NAME=jungle_wagering_test bun run test:e2e | 122 aprovados, 0 falhas |
| DB_NAME=jungle_wagering_test bun run test:distributed | 20 aprovados, 0 falhas; MiniStack real |
| bun run lint | Aprovado, sem avisos |
| bunx tsc --noEmit --incremental false | Aprovado |
| git diff --check | Aprovado |

Total: 230 testes. Também foram conferidos os scripts do package.json, a sintaxe
shell dos exemplos e o Compose com config --quiet. O CLI reconheceu a configuração
compilada em migration:list no banco de teste; não foi executado migration:up no
banco principal. Os exemplos de demonstração não foram enviados ao banco principal.

A revisão de publicação verificou nomes de arquivos rastreados e padrões comuns
de chaves AWS/privadas sem exibir valores. Não substitui scanner completo do
histórico Git. As alterações de código de mensageria já estavam presentes antes
desta preparação; nesta etapa só foram editados README.md, ARCHITECTURE.md,
.gitignore e backend/.env.example. Nenhum commit, push ou publicação foi realizado.
