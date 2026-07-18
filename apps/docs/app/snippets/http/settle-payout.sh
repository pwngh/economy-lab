curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "settlePayout",
    "idempotencyKey": "550e8400-e29b-41d4-a716-446655440002",
    "actor": { "kind": "system", "service": "webhook:tilia" },
    "sagaId": "pay_9f2c1b",
    "providerRef": "acct_77/ps_8821",
    "providerAmount": "USD:48.50"
  }'
