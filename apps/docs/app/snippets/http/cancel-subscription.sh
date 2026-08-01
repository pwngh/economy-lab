curl -s https://economy.example/submit \
  -H 'content-type: application/json' \
  -d '{
    "kind": "cancelSubscription",
    "idempotencyKey": "cancel_sub_abc",
    "actor": { "kind": "user", "userId": "usr_a" },
    "subscriptionId": "sub_abc"
  }'
# → { "status": "committed", "transaction": { "id": "txn_…", … } }
