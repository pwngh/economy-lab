curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "clawback",
    "idempotencyKey": "whk:evt_5521",
    "actor": { "kind": "system", "service": "webhook:billing" },
    "userId": "usr_a1",
    "amount": "CREDIT:600.00",
    "orderId": "ord_8821",
    "reason": "fraudulent_charge"
  }'
# → { "status": "committed", "transaction": { "id": "txn_…", … } }
