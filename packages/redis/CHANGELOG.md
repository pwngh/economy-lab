# Changelog

Notable changes to `@pwngh/economy-redis`, newest first. Dates are npm publish dates.

## Unreleased

### Added

- `redisCache(url)` opens its own connection and returns the `Cache`.
- `redisRateLimiter(url, { limit, windowMs })` opens its own connection and returns the `RateLimiter`.
- Both keep the client-injection form, which returns directly rather than as a promise.
