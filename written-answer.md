# Written Technical Answers

## 1. Database schema evolution with rolling deployment

A service stores user names in users.display_name. A proposed release introduces users.full_name, changes all application reads and writes to the new column, and drops display_name in the same deployment. The service uses rolling deployment, so old and new application instances run concurrently. The release must also support rollback. Explain why this release can fail and propose a safe sequence of database and application changes.

**Answer:**

The release would fail because a rolling deployment cannot atomically switch all frontend/backend instances and database schema. During rollout deployment, old and new instances must be backwards compatible. Dropping display_name and introducing users.full_name in a SAME deployment is not backward compatible. Old services should still CRUD on display_name, which would fail for DBs that swithed to full_name. New insances would only CRUD on full_name, which would failed if they connect to DBs using old schema.

Rollout deploymets should follow a rule: all database changes must be compatible with all service versions that are still serving requests during rollout and rollback window.

Thus, a safe sequence of database and application change is:

1. DB expansion: Expand the schema with ful_name as nullable, backfilling data with full_name = display_name, add a trigger listening to display_name changes and sync to full_name
2. Application change: dual write to both display_name and full_name, while still reading from display_name
3. Application change: read from full_name
4. Applcation change: write to full_name
5. DB: Drop display_name

## 2. Cache consistency race condition

Certificate details are cached for 60 seconds. Request A misses the cache and reads ACTIVE from the database. Before A writes to the cache, request B revokes the certificate, commits the database transaction, and deletes the cache entry. A then writes its stale ACTIVE value into the cache. A colleague proposes reducing the cache TTL to five seconds. Explain why this does not fix the problem. Redesign the read and revocation paths so that any read starting after B returns success cannot receive the stale ACTIVE value.

**Answer:**

This is a typical scenario of race condition：an outdated value was wrtten into cache after a revocation has already invalidated the value.

Fix:

1. use db versioning mechanism and conditionally conduct cache writes
2. while updating cache, instead of deleting the key, update the key with high versioned value

Revocation path:

1. update db with new status and version++
2. update cache
3. return success

Read path:

1. Read from cache
2. If revoked, return
3. If ACTIVE, validate against db on version. If current version, return.
4. If not current version, update cache with condition: db.version > cache.version or key miss
5. return result

## 3. Timeout and retry cascade failure

Service A has 50 request workers. Every request to its /report endpoint calls Service B with a 100 ms timeout and up to three retries. Traffic to /report remains at 1,000 requests per second. B's latency suddenly rises from 20 ms to 2 seconds, and unrelated endpoints on A soon stop responding. Explain the chain of failure, including the effect of retries. Redesign /report so unrelated endpoints remain available, and state what /report should return when B is unhealthy.

**Answer:**

Failure chain:

1. B latency riase to 2s
2. Every B request times out after 100ms, with retry, each request grows from 1 to 4 attempts = 400ms
3. With only 50 workers, completion rate is roughly 50/0.4 = 125 req/s, way smaller than 1000 req/s, jamming the request queue, exhausting the worker pool

Redesign:

1. Give B request a dedicated worker pull, fail fast insdead of queueing
2. Circuit breaker: when failure rate of B exceeds limit, fail immediately
3. Add deadline to retry mechanism to limit the number of retries send to B
4. Separation of concern: separate the logics not related to B out
5. Async I/O: request to B would not block main logic
6. exponential backoff
