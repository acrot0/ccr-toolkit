# The gateway knows why it failed. It just won't tell you.

I run Claude Code through a local gateway — [Claude Code Router](https://github.com/musistudio/claude-code-router),
CCR for short. It sits on port 3456 and routes every request to whichever
upstream I've configured.

When a request fails, CCR shows me an error. On a bad day that error is empty.
And here's the thing that took me too long to notice:

**The gateway had already written down exactly what went wrong. It just never
showed me.**

---

## Four of seven

I went looking. Not by reading source — by querying the database CCR keeps.

CCR logs every request to `request-logs.sqlite`. On my machine right now that
file is **166 MB** and holds 639 requests. Seven of them failed.

Here is the complete list, with two columns: what CCR told me, and what the
upstream actually said.

| # | Status | CCR's `error` column | The upstream's actual message |
|---|---|---|---|
| 1954 | 499 | `Client connection closed before response completed.` | — (no body) |
| 1996 | 429 | *(empty)* | 请求过于频繁 |
| 2020 | 499 | `Client connection closed before response completed.` | — (no body) |
| 2050 | 400 | *(empty)* | `The provided messages input is invalid. The error info is [Can only get item pairs from a mapping.].` |
| 2088 | 400 | *(empty)* | 请求包含未知字段 |
| 2258 | 499 | `Client connection closed before response completed.` | — (no body) |
| 2450 | 400 | *(empty)* | `The provided messages input is invalid. The error info is [Can only get item pairs from a mapping.].` |

**Four of seven had an empty `error` column. In all four, the answer was sitting
in `response_body_text`.**

That column is not hidden. It's not encrypted. It's in the same row, one field
over. Nothing reads it.

---

## Why this is worse than it sounds

An empty error is not neutral. It actively misleads, because it points you at
the wrong layer.

When CCR tells me nothing, my instinct is *"the gateway is flaky."* So I restart
it. I check the config. I switch providers. I burn an evening on the wrong
component.

The actual answer, in two of those rows, was:

```
The provided messages input is invalid.
The error info is [Can only get item pairs from a mapping.].
```

Translated: **an assistant turn in the conversation had a `tool_use` block with
no matching `tool_result`.** That's a conversation-state bug. The gateway is
fine. The provider is fine. Restarting anything would never have helped.

The third one — `请求包含未知字段`, "the request contains an unknown field" — is
equally actionable and equally invisible. Though I'll grant you it's only
half-helpful: the upstream declines to say *which* field.

---

## The second layer: the error that exists but doesn't localize

Some failures do carry a message. That's better, but it still doesn't tell you
**where** in the pipeline it broke.

CCR writes a forensic chain for every request — I measured it: **7 hops for a
normal call, up to 16 for one that retried.** Each hop records the before/after
of every field it touched.

A normal request:

```
 0 [ingress   ] request.ingress                ok        0ms
 1 [ingress   ] gateway.header-normalization   ok        0ms  {remove:/headers/x-api-key, +3}
 2 [routing   ] router.route-output            ok        0ms  {replace:/body, +4}
 3 [planning  ] fallback.execution-plan        noop      0ms
 4 [capability] provider.capability-routing    ok        0ms  {replace:/body/model, replace:/routing/model}
 5 [attempt   ] upstream.attempt.prepare       ok        1ms  {remove:/headers/content-length, +1}
 6 [outcome   ] upstream.attempt.outcome       error   796ms → HTTP 400
```

Seven stages. The failure is one line. Reading it answers the question the error
message cannot:

**A 400 that fails at hop ≤3 was already malformed before the gateway touched
it — that's a client bug. A 400 at hop 6 left the gateway intact and came back
rejected — that's a routing or upstream problem.**

Same status code. Opposite fix. The error message does not distinguish them.

And hop 4 shows something I'd have never found otherwise:

```
🔀 hop 4 rewrote the model: tierflow/tierflow → tierflow::anthropic_messages/tierflow
```

The model name I configured is not the model name that went upstream. The
gateway rewrote it into an internal `<provider>::<protocol>/<model>` form. Which
means anything keying off that string — cache identity, pricing tables,
per-model routing — has been silently not matching. Nobody told me. It's in the
log.

---

## What I built

Three things, all read-only. They open the databases with `readOnly: true` and
never write a byte.

**[`ccr-doctor`](https://github.com/acrot0/ccr-toolkit)** — reads
`response_body_text`, extracts the upstream's own explanation, and names the
fault with a next action. Eight classes: `tool-pairing`, `unknown-field`,
`rate-limited`, `client-abort`, `auth`, `upstream-5xx`, `bad-request`, and
`opaque` — the last one being the honest label for "CCR recorded a failure with
nothing a human can act on."

**[`ccr-trace`](https://github.com/acrot0/ccr-toolkit)** — replays the hop chain
and marks the failing one, so you can tell a client bug from a routing bug.

**[`ccr-cache`](https://github.com/acrot0/ccr-toolkit)** — the prompt-cache
check, which taught me the most painful lesson of this whole exercise.

---

## The lesson: I built a liar first

My first version of the cache check flagged two providers as "oscillating."
Their real hit rates are **98.8% and 90.2%**.

Here's what the naive detector did. It asked: *does the hit rate flip between
high and zero?* On my machine, yes — constantly:

```
cache=465664  input=  1358   HIT
cache=     0  input= 40051   miss   ← "drift!"
cache= 71168  input=  1199   HIT
```

Looks damning. It's nothing. That's **a long session ending and a new one
starting.** A new session is *supposed* to start cold — that's the entire point
of a cold start.

If I had shipped that, users would have gone and "fixed" a cache that was
working perfectly. That is worse than shipping nothing, because they'd trust it.

The real signature of drift is narrower: **the prefix is the same size as
before, and the cache vanished anyway.** So compare each miss against the last
prefix that *did* hit. If the size barely moved and the cache still died, the
bytes inside that prefix changed underneath you.

With that rule, the same 9 misses split cleanly:

```
#1945  prefix drift 5.7%  ← real regression
#2021  prefix drift 1.4%  ← real regression
#2052  prefix drift 0.3%  ← real regression
#2345  prefix drift 0.8%  ← real regression
#2497  prefix drift 2.0%  ← real regression
#1953  prefix drift 72.3% ← new session, fine
#2489  prefix drift 91.4% ← new session, fine
#2491  prefix drift 84.7% ← new session, fine
```

And the check now reports healthy on both of those providers — which is the
truth.

I pinned the exact row sequences that fooled the naive version into the test
suite. Not as documentation — as a tripwire. If someone loosens the rule later,
those tests fail.

---

## The uncomfortable general lesson

The data to diagnose these failures was never missing. It was **captured,
stored, and unread** — one column away from the error message that told me
nothing.

That's a specific bug in one tool, but the shape is common. When something logs
everything and surfaces nothing, the logs become a graveyard: technically
complete, practically useless, and worse than useless when the one field you
*are* shown is empty and sends you debugging the wrong layer.

Before you instrument something new, it's worth asking whether you already have
the answer in a column nobody reads.

---

*The tools are MIT-licensed and read-only:
[github.com/acrot0/ccr-toolkit](https://github.com/acrot0/ccr-toolkit).*
*Every number in this post came from querying a real local install — 639
requests, 7 failures, 166 MB of logs.*
