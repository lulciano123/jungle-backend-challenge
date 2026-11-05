
# Architecture — Distributed Wagering Processor

Documento de arquitetura da solução desenvolvida para o [Jungle Gaming Backend Challenge](https://github.com/junglegaming/backend-challenge).

Este documento apresenta as decisões técnicas, os mecanismos de consistência financeira, a arquitetura de mensageria, as estratégias de concorrência e recuperação de falhas, além dos principais trade-offs e limitações da implementação.

Para instruções de instalação, execução e exemplos de utilização, consulte o [README.md](README.md).

## 1. Visão arquitetural

O Distributed Wagering Processor é um backend para processamento de operações financeiras de jogos, com suporte a requisições HTTP e comandos recebidos por Amazon SQS em ambiente local.

A arquitetura utiliza o PostgreSQL como fonte de verdade para:

- Carteiras e saldos materializados.
- Transações financeiras e seus resultados.
- Ledger financeiro imutável.
- Registro de mensagens recebidas (Inbox).
- Eventos de integração pendentes de publicação (Outbox).

A aplicação é dividida em três processos independentes:

1. **HTTP API:** expõe os endpoints e executa operações solicitadas diretamente.
2. **SQS Consumer:** recebe comandos financeiros e executa o mesmo caso de uso utilizado pela API.
3. **Outbox Publisher:** publica eventos de integração persistidos no PostgreSQL.

### Fluxo geral

```text
        Provedor HTTP                  Provedor SQS
              |                             |
              v                             v
         +----------+                +-------------+
         | NestJS   |                | SQS Consumer|
         | HTTP API |                +-------------+
         +----------+                       |
              |                             |
              +-------------+---------------+
                            |
                            v
                +-----------------------+
                | Financial Application |
                | Service               |
                +-----------------------+
                            |
                            v
                +-----------------------+
                | PostgreSQL            |
                |                       |
                | Wallets               |
                | Wager Transactions    |
                | Immutable Ledger      |
                | Inbox                 |
                | Outbox                |
                +-----------------------+
                            |
                            v
                +-----------------------+
                | Outbox Publisher      |
                +-----------------------+
                            |
                            v
                  wager-events.fifo
```

API, consumidor e publisher podem funcionar separadamente, sem depender de sincronização em memória.

O banco de dados é responsável pelas garantias definitivas de atomicidade, unicidade e integridade financeira.

## 2. Organização e responsabilidades

A implementação utiliza Bun, TypeScript, NestJS, MikroORM e PostgreSQL.

A organização do código separa responsabilidades de domínio, aplicação, transporte e infraestrutura.

| Camada | Responsabilidade |
|---|---|
| `domain` | Value Objects, entidades financeiras e eventos |
| `application` | Casos de uso, decisões financeiras e processamento de mensagens |
| `api` | Controllers, validação de requisições e respostas HTTP |
| `infrastructure` | Integração SQS, Outbox e componentes externos |
| `workers` | Inicialização e ciclo de vida dos processos assíncronos |
| `migrations` | Evolução versionada e constraints do banco |

### Papel do MikroORM

O MikroORM é utilizado para:

- Configuração da conexão e do pool PostgreSQL.
- Gerenciamento do `EntityManager`.
- Controle de transações SQL.
- Execução de consultas parametrizadas.
- Gerenciamento de migrations.

O processamento financeiro utiliza SQL explícito dentro das transações do MikroORM.

Essa decisão permite controlar diretamente os bloqueios de linhas, as atualizações condicionais e a ordem das operações financeiras.

**Trade-off:** embora existam Value Objects e entidades encapsuladas, o serviço financeiro trabalha diretamente com registros SQL em várias transições. O projeto não utiliza integralmente o Identity Map ou o Unit of Work como mecanismos de persistência dos agregados.

Por esse motivo, a modelagem inspirada em Domain-Driven Design (DDD) é parcial, e não uma implementação completa de todos os agregados e repositórios propostos no desafio.

### Caso de uso compartilhado

O `BettingService` concentra o processamento de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.

O nome foi mantido por compatibilidade com a evolução inicial do projeto, mas sua responsabilidade atual é mais ampla que o processamento de apostas.

A API HTTP e o consumidor SQS reutilizam esse caso de uso, evitando regras financeiras divergentes entre transportes.

## 3. Modelo financeiro

### 3.1. Representação de dinheiro

O sistema utiliza a classe `Money` como Value Object monetário.

Suas propriedades principais são:

- Implementação baseada em `decimal.js`.
- Configuração decimal isolada, com precisão 40.
- Representação interna encapsulada.
- Objetos imutáveis.
- Operações que retornam novas instâncias.
- Validação de moeda e escala decimal.
- Rejeição de overflow e entradas inválidas.

O PostgreSQL armazena valores financeiros em `NUMERIC(20,2)`.

O limite monetário suportado é:

```text
999999999999999999.99
```

As moedas inicialmente aceitas são `BRL` e `USD`.

As entradas e saídas monetárias utilizam strings com duas casas decimais. O sistema rejeita valores em notação científica, `NaN`, `Infinity`, formatos inválidos e quantidades negativas nos contratos externos.

Valores negativos podem existir internamente para representar deltas de débito, mas não são aceitos como valores financeiros fornecidos pelos clientes.

O serviço lê valores `NUMERIC` como texto e os reconstrói usando `Money`, evitando conversões para `number`.

Da mesma forma, versões de carteira armazenadas como `BIGINT` são representadas por strings nos eventos de integração, preservando a precisão.

### 3.2. Carteiras

Cada carteira possui:

- Identificador único.
- Identificador do jogador.
- Moeda.
- Saldo materializado.
- Versão.
- Datas de criação e atualização.

O PostgreSQL impede a existência de duas carteiras com a mesma combinação de jogador e moeda.

Também são aplicadas constraints para impedir saldo negativo e versão inválida.

A versão inicial da carteira é `1`, sendo incrementada a cada movimentação financeira efetiva.

### 3.3. Operações financeiras

| Operação | Efeito financeiro | Ledger |
|---|---|---|
| `OPENING` | Crédito inicial | `CREDIT`, quando positivo |
| `BET` | Débito | `DEBIT` |
| `WIN` | Crédito | `CREDIT` |
| `LOSS` | Sem movimentação | Nenhum |
| `REFUND` | Crédito da BET original | `CREDIT` |
| `ROLLBACK` de BET | Crédito | `CREDIT` |
| `ROLLBACK` de WIN | Débito | `DEBIT` |
| `ROLLBACK` de REFUND | Débito | `DEBIT` |

A abertura de carteira com saldo inicial zero não gera lançamento financeiro.

`LOSS` registra uma transação processada, mas não modifica o saldo, a versão ou o ledger.

Todas as operações externas exigem valor positivo, inclusive `LOSS`, conforme as restrições do schema atual.

### 3.4. Regras de referências e reversões

As referências externas são resolvidas pela combinação de:

```text
providerId + externalTransactionId
```

Para `REFUND`:

- A transação original deve ser uma `BET`.
- A `BET` deve estar `PROCESSED`.
- Jogador, carteira, moeda e rodada devem corresponder.
- O valor deve ser exatamente igual ao da aposta original.
- A devolução é integral.

Para `ROLLBACK`:

- A referência deve ser `BET`, `WIN` ou `REFUND`.
- A operação referenciada deve estar `PROCESSED`.
- Devem corresponder jogador, carteira, moeda e rodada.
- O valor deve ser integralmente igual ao original.
- O efeito aplicado deve ser o inverso da movimentação original.

O `gameId` não precisa ser igual ao da operação referenciada nas reversões.

Para `WIN`, a referência à `BET` é opcional. Quando informada, são validados o tipo e o escopo financeiro, sem exigir igualdade de valor, igualdade de jogo ou status `PROCESSED` da aposta.

Essas condições representam as regras efetivamente implementadas.

### 3.5. Prevenção de reversões duplicadas

O PostgreSQL possui um índice único parcial sobre:

```text
(reference_transaction_id, kind)
```

A restrição é aplicada às reversões processadas do tipo `REFUND` e `ROLLBACK`.

Isso permite no máximo uma reversão processada de cada tipo para a mesma referência.

Consequentemente, uma mesma `BET` pode receber um `REFUND` e um `ROLLBACK`, uma vez cada, sem uma proibição cruzada adicional.

Operações distintas que tentam repetir uma reversão já processada recebem rejeição persistida.

Replays legítimos, com a mesma chave de idempotência e o mesmo payload, retornam o resultado original.

## 4. Ledger financeiro e integridade

O ledger registra as movimentações financeiras efetivas.

Cada lançamento contém:

- Identificador único.
- Carteira associada.
- Transação associada.
- Direção (`DEBIT` ou `CREDIT`).
- Valor e moeda.
- Saldo anterior.
- Saldo posterior.
- Data de criação.

### 4.1. Imutabilidade

Triggers PostgreSQL impedem:

- `UPDATE` em lançamentos.
- `DELETE` de lançamentos.
- `TRUNCATE` da tabela.

Uma movimentação incorreta não é corrigida modificando um registro antigo. O modelo prevê novas operações financeiras para representar efeitos posteriores.

### 4.2. Constraints de integridade

O schema valida:

- Valores financeiros positivos nos lançamentos.
- Saldos não negativos.
- Direções permitidas.
- Aritmética de crédito e débito.
- Compatibilidade de moeda.
- Integridade das referências entre transações, carteiras e ledger.
- Unicidade dos relacionamentos financeiros aplicáveis.

Uma chave estrangeira composta garante que o lançamento faça referência a uma transação da mesma carteira e moeda.

### 4.3. Limite da garantia

A consistência entre o saldo materializado e o ledger é mantida pelos serviços financeiros, que executam ambas as gravações dentro da mesma transação SQL.

Entretanto, não existe um trigger geral que recalcule toda a soma do ledger a cada alteração direta de `wallets.balance`.

Um escritor externo com privilégios amplos poderia, portanto, provocar uma divergência por SQL executado fora dos casos de uso autorizados.

Os testes verificam a reconstrução de saldo em cenários financeiros, mas o endpoint administrativo de reconciliação não está implementado.

Uma implantação produtiva exigiria controle rigoroso das permissões de escrita e reconciliação periódica.

## 5. Concorrência e isolamento

### 5.1. Bloqueio por carteira

O processamento utiliza:

```sql
SELECT ...
FROM wallets
WHERE id = ?
FOR UPDATE;
```

O bloqueio é mantido enquanto a transação financeira decide e persiste seus efeitos.

Requisições concorrentes sobre a mesma carteira são serializadas pelo PostgreSQL.

Requisições referentes a carteiras distintas não dependem de um lock global compartilhado.

### 5.2. Atualização condicionada

As movimentações utilizam operações SQL com delta monetário e atualização de versão.

O próprio PostgreSQL verifica a condição de saldo não negativo para os débitos.

O serviço também compara o saldo retornado pelo banco com o resultado calculado por `Money`.

Divergências inesperadas interrompem a operação e provocam rollback.

### 5.3. Concorrência entre processos

As garantias não dependem de mutexes ou mapas mantidos em memória.

Assim, processos distintos podem compartilhar o mesmo PostgreSQL e disputar uma carteira com as mesmas regras.

A suíte de testes inclui cenários com processos independentes, chamadas simultâneas e mensagens duplicadas.

**Trade-off:** uma carteira muito disputada se torna um ponto de serialização. Essa decisão prioriza correção financeira e isolamento por carteira. Não foi realizado um benchmark abrangente de throughput.

A versão da carteira é utilizada como informação de estado e auditoria; não substitui o bloqueio pessimista por um mecanismo de optimistic locking.

## 6. Idempotência persistente

Cada operação financeira possui:

- `idempotency_key`.
- Identificador do provedor.
- Identificador externo da transação.
- Hash canônico do payload.
- Resposta original persistida.

O banco aplica unicidade global à chave de idempotência e unicidade à combinação de provedor e referência externa.

### 6.1. Hash canônico

O serviço calcula um SHA-256 sobre uma representação determinística dos campos financeiros.

Os campos incluem:

- Valor normalizado e moeda.
- Tipo da operação.
- Jogador e carteira.
- Provedor e identificador externo.
- Rodada e jogo.
- Referência externa, quando aplicável.

UUIDs são normalizados para letras minúsculas. Os identificadores textuais preservam sua capitalização.

O hash não inclui o header de idempotência nem detalhes específicos do transporte HTTP ou SQS.

### 6.2. Política de replay

Uma operação anterior só pode ser reutilizada quando:

1. A chave de idempotência corresponde.
2. O payload canônico corresponde.
3. A identidade externa da operação não representa um conflito.

Caso contrário, o sistema retorna um conflito de idempotência.

Não é permitido associar implicitamente uma segunda chave a uma operação externa já registrada.

### 6.3. Resposta original

A transação armazena `original_response`, incluindo o saldo observado quando a operação foi registrada.

Um replay retorna essa resposta original, mesmo que a carteira tenha sofrido outras movimentações posteriormente.

O replay não:

- Atualiza novamente o saldo.
- Incrementa a versão.
- Cria outro lançamento no ledger.
- Publica novos eventos da mesma operação.

Essa garantia é persistente e não depende de cache em memória.

## 7. Fronteiras transacionais

### 7.1. Processamento HTTP

No caminho HTTP, o caso de uso financeiro abre sua própria transação PostgreSQL.

As seguintes operações são executadas dentro dessa fronteira:

1. Bloqueio da carteira.
2. Verificação de idempotência.
3. Validação financeira e de referências.
4. Persistência da transação e de seu resultado.
5. Atualização da carteira, quando aplicável.
6. Inserção do ledger, quando aplicável.
7. Persistência dos eventos na Outbox.

Se qualquer etapa obrigatória falhar, o PostgreSQL desfaz a transação inteira.

### 7.2. Processamento SQS

O consumidor cria uma transação externa e executa o caso de uso compartilhado por meio de `submitTransactionInTransaction`.

Esse método utiliza a transação já ativa, sem confirmar independentemente a movimentação financeira.

A fronteira abrange:

```text
BEGIN
  |
  +-- Inbox
  |
  +-- Validação e idempotência financeira
  |
  +-- Wager Transaction
  |
  +-- Wallet / Ledger
  |
  +-- Outbox
  |
COMMIT
  |
  v
SQS ACK
```

A confirmação da mensagem no SQS ocorre somente depois do commit PostgreSQL.

Essa ordem evita a perda de uma operação por confirmação prematura.

Se o processo cair depois do commit e antes do ack, a mensagem poderá ser entregue novamente. A Inbox e a idempotência financeira impedem reaplicação do efeito.

### 7.3. Garantia oferecida

O sistema busca **efeito financeiro único por operação idempotente**, apesar da entrega de mensagens potencialmente repetida.

Isso não equivale a garantir entrega exactly-once pelo broker.

A consistência financeira é garantida pela persistência transacional e pelas constraints do PostgreSQL; o SQS opera com semântica at-least-once.

## 8. Transactional Inbox

A Inbox registra mensagens consumidas para permitir deduplicação durável.

A identificação utiliza a combinação:

```text
consumer_name + message_id
```

O `messageId` corresponde ao identificador do envelope de aplicação, não ao identificador atribuído pelo SQS.

### 8.1. Validação de conteúdo

O consumidor calcula um hash SHA-256 do envelope, utilizando uma representação com chaves ordenadas recursivamente.

Se o mesmo identificador for recebido com conteúdo diferente, a mensagem é tratada como conflito.

O hash da Inbox representa a identidade do envelope recebido.

Já o hash financeiro representa a identidade da operação de negócio.

São verificações diferentes e complementares.

### 8.2. Mensagem duplicada

Quando uma mensagem já confirmada é recebida novamente:

- A Inbox identifica a duplicação.
- A operação financeira não é reaplicada.
- O consumidor pode confirmar a entrega sem gerar novos efeitos.

Se uma operação já foi concluída por HTTP e depois chega pelo SQS, a idempotência financeira também impede a segunda movimentação.

### 8.3. Rejeições e falhas

Rejeições de negócio persistidas são consideradas resultados concluídos e podem receber ack.

Mensagens inválidas, conflitos de identidade e erros permanentes seguem o tratamento de DLQ antes da remoção da mensagem original.

Falhas transitórias de SQL ou comunicação são tratadas com tentativas posteriores.

O mecanismo de redrive da fila de comandos está configurado para um limite de cinco recebimentos.

### 8.4. Referências fora de ordem

Quando a referência exigida não é encontrada, a operação pode ser persistida como:

```text
PENDING_REFERENCE
```

Nesse estado:

- O comando fica registrado.
- A resposta original é armazenada.
- O evento correspondente é criado.
- O saldo não é alterado.
- Nenhum lançamento financeiro é inserido.

A mensagem SQS pode ser confirmada porque o estado pendente já foi persistido.

**Limitação importante:** ainda não existe um worker que resolva automaticamente essas pendências quando a referência original chegar.

Também não há backoff, TTL ou limite de tentativas implementados especificamente para a resolução de `PENDING_REFERENCE`.

O mecanismo de retry da fila não deve ser confundido com o reprocessamento de referências financeiras pendentes.

## 9. Transactional Outbox

A Outbox resolve o problema de consistência entre o commit financeiro no PostgreSQL e a publicação de eventos no SQS.

O serviço não depende de publicar a mensagem diretamente durante uma transação financeira.

Em vez disso, grava o evento no banco, dentro do mesmo commit da operação.

Um processo separado realiza a publicação posteriormente.

### 9.1. Modelo de eventos

Os eventos utilizam uma classe abstrata `IntegrationEvent`, subclasses concretas e versão de contrato.

Os envelopes incluem informações como:

- `eventId`.
- `aggregateId`.
- `correlationId`.
- `causationId`, quando aplicável.
- `occurredAt`.
- Tipo e versão do evento.
- Payload tipado.

Os valores financeiros seguem a representação monetária segura definida pelo domínio.

Os eventos implementados são:

| Evento | Finalidade |
|---|---|
| `WagerTransactionProcessed` | Operação financeira concluída |
| `WagerTransactionRejected` | Operação rejeitada por regra de negócio |
| `WalletBalanceChanged` | Saldo da carteira alterado |
| `WagerTransactionPendingReference` | Operação aguardando referência |

A abertura de carteira com saldo inicial positivo também produz eventos.

Não foi realizado backfill para operações históricas anteriores à criação da Outbox.

### 9.2. Publicação concorrente

O publisher utiliza:

```sql
SELECT ...
FOR UPDATE SKIP LOCKED;
```

Os eventos são reivindicados com um token de claim e um lease de 60 segundos.

A transação utilizada para o claim é encerrada antes da chamada de rede ao SQS.

Isso evita manter bloqueios SQL abertos durante operações externas.

Depois de receber a confirmação do broker, o publisher registra `published_at`, condicionado ao token do claim.

### 9.3. Recuperação após falhas

Eventos não publicados permanecem registrados no PostgreSQL.

Se o publisher morrer após assumir um evento, o lease permite que outro processo o recupere quando expirar.

Falhas de publicação geram novas tentativas com backoff persistente, limitado a um intervalo máximo de uma hora.

Não há limite terminal de tentativas do publisher nem mecanismo automático de alerta para eventos continuamente problemáticos.

### 9.4. Publicação at-least-once

Existe uma janela de falha inevitável entre:

1. O SQS aceitar o evento.
2. O PostgreSQL registrar o evento como publicado.

Se o processo morrer nesse intervalo, o evento pode ser enviado novamente.

O `eventId` permanece estável e é usado como identificador de deduplicação na fila FIFO.

Entretanto, a janela de deduplicação da fila é limitada.

Por isso, consumidores downstream devem implementar deduplicação persistente pelo `eventId`.

Não existe um consumidor downstream de eventos nesta entrega.

### 9.5. Ordenação de eventos

Publishers concorrentes podem publicar eventos da mesma carteira fora da ordem em que foram produzidos.

O evento `WalletBalanceChanged` inclui a versão da carteira como string.

Essa informação permite que futuras projeções detectem eventos atrasados ou versões já processadas.

A implementação atual não fornece uma projeção downstream com ordenação garantida.

## 10. Infraestrutura SQS e workers

A mensageria utiliza AWS SDK v3 e MiniStack local.

As filas são separadas por finalidade:

| Fila | Responsabilidade |
|---|---|
| `wager-transactions.fifo` | Receber comandos financeiros |
| `wager-transactions-dlq.fifo` | Receber comandos problemáticos |
| `wager-events.fifo` | Receber eventos de integração |
| `wager-events-dlq.fifo` | DLQ disponível para futuros consumidores |

As filas de comandos e eventos não formam um ciclo.

O consumidor financeiro não consome os eventos publicados pela Outbox.

### 10.1. Timeouts

O consumidor configura limites operacionais para transações:

- Lock timeout: 5 segundos.
- Statement timeout: 15 segundos.
- Transaction timeout: 20 segundos, no PostgreSQL 17.
- Visibility timeout SQS: 60 segundos.

Os timeouts SQL foram definidos abaixo da janela de visibilidade da mensagem.

Essa relação reduz a possibilidade de duas tentativas executarem simultaneamente uma operação ainda em andamento.

A proteção financeira definitiva, contudo, permanece no PostgreSQL.

### 10.2. Encerramento

Os workers tratam sinais como `SIGTERM` e `SIGINT`.

Ao receber o sinal de encerramento, interrompem a busca por novos trabalhos e aguardam operações em andamento conforme sua lógica de shutdown.

Caso o processo termine abruptamente, mensagens não confirmadas podem retornar à fila após expiração da visibilidade.

A Inbox e a idempotência financeira tratam possíveis redeliveries.

### 10.3. Limitações operacionais

A implementação não inclui:

- Autoscaling.
- Supervisor automático de reinicialização.
- Painel administrativo de DLQ.
- Alertas de tentativas excessivas.
- Implantação em AWS real.

O MiniStack é utilizado como infraestrutura de teste local. Sua persistência não deve ser confundida com as garantias operacionais de um serviço gerenciado.

## 11. Segurança e autenticação

A aplicação prioriza a validação financeira e o processamento distribuído em ambiente local.

A versão entregue **não implementa autenticação ou autorização de provedores**.

Também não há rate limiting ou vínculo autenticado entre `providerId` e uma identidade verificada.

Os identificadores recebidos são validados estruturalmente e pelas regras de domínio, mas isso não substitui autenticação.

Consequentemente, **a API não deve ser exposta publicamente sem uma camada adicional de segurança**.

### 11.1. Evolução proposta

Uma implantação produtiva poderia utilizar:

- Identity Provider compatível com OpenID Connect (OIDC), como Keycloak.
- Guards do NestJS.
- Verificação de assinatura, issuer, audience e expiração de tokens.
- Identificação autenticada do provedor.
- Autorização por escopo e operação.
- Rate limiting e auditoria de acesso.

Uma interface `ProviderIdentityPort` na camada de aplicação poderia relacionar a identidade autenticada com o `providerId` utilizado nas operações financeiras.

Nesse desenho, endpoints públicos de health continuariam separados das operações financeiras protegidas.

**Esse é um ponto de extensão arquitetural proposto, não implementado.** Não existe Guard ou porta dedicada de autenticação na versão atual.

As credenciais fictícias `test/test` são utilizadas exclusivamente para comunicação com o SQS local.

## 12. Observabilidade

A aplicação disponibiliza:

- `GET /health/live`.
- `GET /health/ready`.
- Logs básicos dos processos e workers.

O endpoint de readiness verifica a conectividade com PostgreSQL e a disponibilidade das filas SQS necessárias.

A implementação ainda não possui observabilidade completa para produção.

Entre as evoluções necessárias estão:

- Logs estruturados com correlação consistente entre HTTP, SQS e banco.
- Métricas por tipo de operação e status.
- Métricas de idempotência e duplicações.
- Número e duração de retries.
- Contagem e acompanhamento de mensagens em DLQ.
- Latência de processamento financeiro.
- Conflitos e tempo de espera por locks.
- Idade dos eventos pendentes na Outbox.
- Distributed tracing.
- Dashboards e alertas.

Falhas inesperadas na API HTTP continuam utilizando o tratamento padrão de erro do NestJS em parte dos caminhos, sem uma taxonomia completa de indisponibilidade transitória.

## 13. Testes e validação

A implementação foi validada em 4 de novembro de 2026, utilizando Bun Test, PostgreSQL real e MiniStack local.

### 13.1. Resultados

| Validação | Resultado |
|---|---|
| `bun run build` | Aprovado |
| `bun run test` | 88 testes aprovados |
| `DB_NAME=jungle_wagering_test bun run test:e2e` | 122 testes aprovados |
| `DB_NAME=jungle_wagering_test bun run test:distributed` | 20 testes aprovados |
| `bun run lint` | Aprovado, sem avisos |
| `bunx tsc --noEmit --incremental false` | Aprovado |

**Total: 230 testes aprovados, sem falhas reportadas na última validação.**

O TypeScript utiliza `strict`, com `strictPropertyInitialization=false` e `skipLibCheck=true`.

### 13.2. Cobertura relevante

Os testes incluem:

- Precisão monetária e limites de valores.
- Validação de moedas.
- Integridade e imutabilidade do ledger.
- Abertura de carteiras.
- Processamento de BET, WIN, LOSS, REFUND e ROLLBACK.
- Rejeição por saldo insuficiente.
- Conflitos de idempotência.
- Replays após movimentações posteriores.
- Concorrência entre operações na mesma carteira.
- Processos independentes compartilhando o PostgreSQL.
- Redelivery de mensagens SQS.
- Deduplicação da Inbox.
- Rollback integral após falha no ledger.
- Rollback integral após falha na Outbox.
- Processamento HTTP seguido por SQS.
- Retry e encaminhamento para DLQ.
- Publishers concorrentes.
- Recuperação de claims abandonados.
- Falhas de processo com `SIGKILL`.
- Encerramento controlado com `SIGTERM`.

Os testes distribuídos utilizam infraestrutura real em containers.

### 13.3. Limites da validação

Nem todos os cenários possíveis de infraestrutura foram reproduzidos.

Não foram comprovados especificamente:

- Reinício forçado do container MiniStack durante operações.
- Indisponibilidade prolongada de rede.
- Deduplicação após o fim da janela FIFO do broker.
- Cenário isolado de `SIGINT`.
- Benchmark completo de throughput sob carga sustentada.
- Reprodução integral em uma segunda máquina limpa.

Nos testes de recuperação, alguns leases foram antecipados para verificar a retomada sem aguardar seu prazo operacional completo.

A execução bem-sucedida da suíte valida os cenários implementados, mas não constitui garantia de ausência de falhas ou conformidade integral com todos os requisitos do desafio.

## 14. Limitações e evolução futura

A implementação atual prioriza as invariantes financeiras e os mecanismos transacionais de mensageria.

| Área | Situação atual | Evolução recomendada |
|---|---|---|
| Operações financeiras | Implementadas | Ampliar avaliação de cenários extremos |
| Concorrência e idempotência | Implementadas | Realizar benchmarks e testes prolongados |
| Inbox e Outbox | Implementadas | Melhorar métricas, alertas e operação |
| Referências fora de ordem | Parcial | Worker de resolução com backoff, TTL e limite de tentativas |
| Reconciliação financeira | Não implementada | Endpoint e processo periódico de comparação com ledger |
| Consultas HTTP | Não implementadas | Carteira, transações e extrato paginado |
| Modelagem DDD | Parcial | Agregados e repositórios mais completos |
| Autenticação | Não implementada | OIDC, Guards e identidade de provedores |
| Observabilidade | Parcial | Métricas, tracing e correlação |
| Consumidores de eventos | Não implementados | Projeções e deduplicação downstream |
| CI/CD | Não implementado | Pipeline de build, testes e análise estática |
| Operação produtiva | Fora do escopo | Backup, retenção, deploy, supervisão e recuperação |

Também não foi implementado um ledger de partidas dobradas. O modelo atual utiliza lançamentos de movimentação por carteira, com saldo anterior e posterior.

Os métodos `down` das migrations estão definidos, mas não foram validados por uma execução completa de reversão durante a preparação da entrega.

Essas limitações não invalidam os testes das funcionalidades existentes, mas restringem o escopo da solução frente ao edital e aos requisitos de um ambiente financeiro produtivo.

## 15. Considerações finais

A arquitetura foi construída priorizando três objetivos:

1. **Correção financeira:** representar dinheiro com precisão decimal, impedir saldos negativos e preservar um ledger imutável.
2. **Consistência sob concorrência:** utilizar o PostgreSQL para controlar locks, transações e idempotência entre processos independentes.
3. **Recuperação de falhas:** desacoplar entrada de comandos e publicação de eventos por meio de SQS, Inbox e Transactional Outbox.

O principal trade-off foi concentrar o processamento financeiro em serviços com SQL explícito e utilizar o PostgreSQL como autoridade de consistência, em vez de buscar uma abstração de persistência mais extensa.

A solução demonstra o núcleo financeiro e os mecanismos distribuídos implementados, com testes de integração e recuperação em infraestrutura local.

Funcionalidades ainda ausentes, como resolução automática de referências pendentes, consultas financeiras, reconciliação e autenticação, estão identificadas para que os limites da entrega sejam claros.

---

**Documentos relacionados**

- [README.md](README.md) — instalação, execução, API HTTP, SQS e testes.
- [infra/MESSAGING.md](infra/MESSAGING.md) — infraestrutura de mensageria, filas e workers.
- [Jungle Gaming Backend Challenge](https://github.com/junglegaming/backend-challenge) — especificação original.
