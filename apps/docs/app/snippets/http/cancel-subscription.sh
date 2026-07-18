curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "cancelSubscription",
    "idempotencyKey": "idem_1",
    "actor": { "kind": "user", "userId": "usr_a" },
    "subscriptionId": "sub_abc"
  }'
