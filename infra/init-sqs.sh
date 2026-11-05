#!/bin/sh
set -eu
# Emulator credentials only. This script never targets AWS.
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
endpoint=http://localhost:4566

create_queue() {
  awslocal --endpoint-url "$endpoint" sqs create-queue --queue-name "$1" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false \
    --query QueueUrl --output text
}

configure_pair() {
  source_url=$(create_queue "$1")
  dlq_url=$(create_queue "$2")
  dlq_arn=$(awslocal --endpoint-url "$endpoint" sqs get-queue-attributes \
    --queue-url "$dlq_url" --attribute-names QueueArn --query Attributes.QueueArn --output text)
  attributes=$(python -c 'import json,sys; print(json.dumps({"VisibilityTimeout":"60","ReceiveMessageWaitTimeSeconds":"20","MessageRetentionPeriod":"345600","RedrivePolicy":json.dumps({"deadLetterTargetArn":sys.argv[1],"maxReceiveCount":"5"})}))' "$dlq_arn")
  awslocal --endpoint-url "$endpoint" sqs set-queue-attributes --queue-url "$source_url" --attributes "$attributes"
  awslocal --endpoint-url "$endpoint" sqs set-queue-attributes --queue-url "$dlq_url" --attributes MessageRetentionPeriod=1209600
}

configure_pair wager-transactions.fifo wager-transactions-dlq.fifo
configure_pair wager-events.fifo wager-events-dlq.fifo
