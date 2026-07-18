curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "requestPayout",
    "idempotencyKey": "payout_2026_02",
    "actor": { "kind": "user", "userId": "usr_a1" },
    "userId": "usr_a1",
    "amount": "CREDIT:25000.00"
  }'
