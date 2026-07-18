curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "topUp",
    "idempotencyKey": "idem_0",
    "actor": { "kind": "system", "service": "payments" },
    "userId": "usr_buyer",
    "amount": "CREDIT:50.00",
    "source": "card"
  }'
