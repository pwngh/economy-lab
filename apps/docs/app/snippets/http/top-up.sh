curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "topUp",
    "idempotencyKey": "purchase_evt_5521",
    "actor": { "kind": "system", "service": "payments" },
    "userId": "usr_buyer",
    "amount": "CREDIT:600.00",
    "source": "card"
  }'
# → { "status": "committed", "transaction": { "id": "txn_…", … } }
