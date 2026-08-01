curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "requestPayout",
    "idempotencyKey": "payout_2026_07_usr_a1",
    "actor": { "kind": "user", "userId": "usr_a1" },
    "userId": "usr_a1",
    "amount": "CREDIT:25000.00"
  }'
# → { "status": "committed", "transaction": { "id": "txn_…", … } }
