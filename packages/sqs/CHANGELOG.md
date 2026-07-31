# Changelog

Notable changes to `@pwngh/economy-sqs`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `sqs({ queueUrl, region? })` opens the AWS client, translates the command, and returns the `Dispatcher`.
- `sqsDispatcher({ queueUrl, client })` is the client-injection form, for a caller who opened the client.
