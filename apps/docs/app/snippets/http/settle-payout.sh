curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "settlePayout",
    "idempotencyKey": "whk:evt_ps_8821",
    "actor": { "kind": "system", "service": "webhook:tilia" },
    "sagaId": "pay_9f2c1b",
    "providerRef": "acct_77/ps_8821",
    "providerAmount": "USD:125.00"
  }'
# → { "status": "committed", "transaction": { "id": "txn_…", … } }
