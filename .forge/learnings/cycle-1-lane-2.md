# Learnings — Cycle 1, Lane 2: core-eventbus (attempt 2)

## FRICTION
- **Review V1**: Test for `publish()` await guarantee used sync side-effect (`received.push()`), which would pass even with fire-and-forget dispatch. Fixed: added async handler with 50ms delay, asserting `handlerFinished === true` after `await publish()` (`src/bus/bus.test.ts:120-127`).
- **Review V1**: Test for persist-before-dispatch was implicit. Fixed: handler reads DB during execution to verify event row exists before dispatch completes (`src/bus/bus.test.ts:129-137`).
- **Review V2**: `subscribe(eventType, handler)` required eventType as string. Spec says "optional filter by event type". Fixed with function overloads: `subscribe(handler)` defaults to `*` pattern (`src/bus/index.ts:15-17`).
- `better-sqlite3` ABI mismatch continues across sessions. Always run `npm rebuild better-sqlite3` first.

## GAP
- Spec doesn't specify what `subscribe()` should store in DB when no eventType given. Decision: store `*` as event_type in subscriptions table.
- Spec says "optional filter by event type" — could mean optional parameter or optional filtering logic. Chose: optional parameter via overload.

## DECISION
- **Function overloads for subscribe()** (`src/bus/index.ts:15-17`): Two signatures — `subscribe(eventType, handler, options?)` and `subscribe(handler, options?)`. Runtime dispatch checks `typeof` first arg. Unfiltered uses `*` pattern.
- **Persist-before-dispatch test** (`src/bus/bus.test.ts:129-137`): Handler reads store during execution to verify row exists. This locks the ordering guarantee.
- **Async await test** (`src/bus/bus.test.ts:120-127`): 50ms setTimeout in handler, assert flag after `await publish()`. Fire-and-forget would fail this.

## SURPRISE
- TypeScript overloads required careful typing of the implementation signature — `handlerOrOptions` parameter can be `EventHandler | SubscribeOptions`, requiring runtime type check (`typeof eventTypeOrHandler === 'string'`).

## DEBT
- None. All review violations addressed.
