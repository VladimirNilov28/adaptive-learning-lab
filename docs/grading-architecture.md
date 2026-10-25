# Grading & Analytics Architecture

**AI teaches. Code grades. AI analyzes.**

Ordinary exercise grading never requires an AI call. No student code is ever executed — not in a
container, not in a VM, not in a subprocess. Answers are parsed and compared as text.

---

## 1. Design rules

| Rule | How it is enforced |
| --- | --- |
| Grading is deterministic | `gradeQuestion()` is a pure function of (question snapshot, answer). No clock, no randomness, no network. |
| Grading is local | Every library is zero/low-dependency and runs in-process. No external service is contacted. |
| Student code is never executed | Bash answers are *parsed* by `shell-quote`; the resulting tokens are inspected. Nothing is spawned. |
| Answer keys never reach the browser | `StudentQuestion` omits `grading` permanently, and `correctAnswer`/`explanation` only after submission. |
| The engine never invents certainty | Anything the engine cannot decide becomes `needs_review`, not `incorrect`. |
| Migrations are additive | Only `ALTER TABLE ... ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`, and a rebuildable view. No backfill of invented data. |

---

## 2. Libraries evaluated

All candidates were checked with `npm view` for licence, latest release date, and install weight.

### Adopted

| Library | Version | Licence | Why |
| --- | --- | --- | --- |
| [`shell-quote`](https://www.npmjs.com/package/shell-quote) | ^1.12.0 | MIT | Pure-JS POSIX shell tokenizer, ~26 KB, zero runtime deps, maintained by ljharb. Gives commands, operands, flags, pipes, and redirections without executing anything. |
| [`json-logic-js`](https://www.npmjs.com/package/json-logic-js) | ^2.0.5 | MIT | The de-facto standard for serialisable rule expressions. No `eval`, no function calls, no property assignment — safe to store in SQLite and apply to untrusted-ish data. Zero deps. |
| [`safe-regex2`](https://www.npmjs.com/package/safe-regex2) | ^5.1.2 | MIT | Fastify-maintained star-height analysis. Rejects instructor patterns that risk catastrophic backtracking *before* they are stored. |
| [`simple-statistics`](https://www.npmjs.com/package/simple-statistics) | ^7.12.1 | ISC | Zero-dependency statistics; only `linearRegression` is used, for the accuracy trend line. Avoids a hand-rolled, untested least-squares implementation. |
| `@types/shell-quote`, `@types/json-logic-js` | ^1.7.5, ^2.0.8 | MIT | Type definitions only (devDependencies). |

### Rejected

| Candidate | Reason |
| --- | --- |
| `tree-sitter-bash` + `web-tree-sitter` | ~20 MB and a native build step. A full bash grammar is far more than structural assertions need, and native builds break the "clone and run" promise. |
| `bash-parser` | No release since 2022; pulls a large transitive tree. Unmaintained parsing of untrusted text is a liability. |
| `recheck` | Excellent ReDoS analysis, but ~11 MB with a worker runtime. `safe-regex2` covers the realistic instructor-authored cases at a fraction of the cost. |
| `re2` | Native binding (~13 MB) that would make regex grading depend on a compiler toolchain. |
| `mathjs` | Large expression engine; numeric grading needs only `Number()` plus a tolerance comparison. |
| `json-logic-engine` | Faster, but `json-logic-js` is the stable reference implementation with the widest documentation. Speed is irrelevant for single-student grading. |
| Any sandbox/container runner (`vm2`, Docker, Firecracker) | Out of scope by design. Executing student code is explicitly not a goal; static analysis plus instructor review covers the gap honestly. |

---

## 3. Module layout

```
src/lib/grading/
  normalize.ts  opt-in text normalization (every flag defaults to false)
  bash.ts       shell-quote wrapper + structural constraint checker
  rules.ts      json-logic allowlist, sandbox limits, and fact set
  config.ts     the 11-strategy Zod discriminated union
  engine.ts     gradeQuestion() — the single grading entry point
  index.ts      barrel re-export
src/lib/analytics.ts  read-only metrics over the question_attempts view
```

`src/lib/store.ts` is the only caller that writes grading results; `src/mcp.ts`, the student API
route, and the UI all read what the store produced.

---

## 4. Strategies

| Strategy | Applies to | Behaviour |
| --- | --- | --- |
| `single_choice` | single-choice | Exact option set. |
| `multiple_choice` | multiple-choice | Exact set by default; `partialCredit` awards a share per correct option, and `penalizeIncorrect` (default **on**) subtracts wrong picks so "select everything" scores zero. |
| `exact_match` | written | Byte-for-byte against `expected[]`; `caseSensitive` is the only relaxation. |
| `normalized_match` | written | `expected[]` compared after explicit normalization flags. |
| `accepted_answers` | written | Any member of `accepted[]` after normalization. |
| `numeric` | numeric / written | Parses the answer; matches on exact value, `absoluteTolerance`, or `relativeTolerance`. Thousands separators tolerated. |
| `output_match` | predict-output | Like `accepted_answers` but defaults to line-ending/trailing-newline tolerance, keeping internal whitespace significant. |
| `regex_match` | written | Instructor pattern, validated by `safe-regex2`. `fullMatch` (default on) anchors the pattern. Flags limited to `imsu`. |
| `rule` | written | json-logic expression over a fixed fact set. Boolean → all-or-nothing; number → 0..1 partial credit. |
| `bash_structure` | command answers | Structural assertions over the parsed command (see below). |
| `manual` | anything | Explicit instructor review. |

Omitting `grading` preserves pre-existing behaviour exactly: choice questions keep exact-set
grading, written questions keep instructor review.

### `bash_structure`

The answer is tokenized with `shell-quote`, then checked against the question's assertions.

**Why presence checks were not enough.** The first version only verified that required tokens were
*present*. `grep -n "ERROR" app.log` and `grep -nv "ERROR" app.log` contain exactly the same
required tokens while doing opposite things, so wrong answers scored full marks. The same held for
`grep -n app.log "ERROR"` (operands swapped), for extra operands, and for a second statement
smuggled in after a correct one (`grep -n "ERROR" app.log; rm -rf /`). The fix is **closure**: the
checker now accounts for *everything* in the answer, not just the parts the instructor listed.

Constraints come in two kinds:

| Kind | Fields |
| --- | --- |
| Positive (what must be there) | `command`, `requiredCommands`, `pipeline`, `requiredFlags`, `requiredFlagValues`, `requiredArguments`, `requiredRedirections`, `minPipeSegments`, `quotedArguments` |
| Closing (what may *not* be there) | `exactFlags`, `allowedFlags`, `positionalArguments`, `allowExtraArguments`, `allowExtraRedirections`, `maxStatements` (default 1), `maxPipeSegments`, `forbiddenFlags`, `forbiddenCommands`, `forbiddenArguments`, `forbiddenRedirections` |

Supporting fields: `flagAliases` declares equivalent spellings (`{"-n": ["--line-number"]}`) —
equivalence is never *inferred*, because only the instructor knows whether a long option is
acceptable; `flagsWithValues` declares options that consume the next word (`-m 5`, `-m5`) so the
value is not mistaken for an operand; `argumentOrder: "any"` relaxes operand order deliberately.
Clustered short flags (`-la`) are expanded to `-l` and `-a`.

`completeness` decides how a partially specified question behaves:

- **`strict`** (the default for new configurations) requires closure — `command` or `pipeline`,
  `exactFlags` or `allowedFlags`, and `positionalArguments` or `allowExtraArguments`. Zod rejects
  anything less with a message naming the missing field and explaining which wrong answer would
  otherwise slip through. A strict question grades definitively: `correct` or `incorrect`.
- **`open`** allows partial constraints. Positive assertions still fail an answer, but anything the
  rules do *not* describe — an undeclared option, an extra operand, an extra statement, an
  unrequested redirection, operands appearing in a different order than listed — yields
  **`needs_review`**, never `correct`.

Stored configurations written before this change carry no `completeness` field, so they are read as
`open`. That migrates them conservatively without touching the database: their true positives keep
passing, and every false positive above becomes an instructor review instead of a free point.

`alternatives` holds additional, independently sufficient constraint sets, so a question can accept
`grep -c ERROR app.log` *and* `grep ERROR app.log | wc -l` without a regular expression.
`acceptedAnswers` still matches verbatim answers after normalization.

**Three outcomes, not two.** The checker returns `failures` (verified wrong) separately from
`ambiguities` (observed but unjudgeable). The engine only reports `correct` when an alternative
produces neither. Unbalanced quoting is objectively invalid shell and is `incorrect` with
`syntax_error`; a *tokenizer* failure or an unsupported construct — variables (`$f`), command or
process substitution, backticks, subshells, brace expansion, here-documents, loops and conditionals
— is a limit of the checker, not evidence about the student, so it returns `needs_review`.
Instructors may additionally set `onMismatch: "needs_review"` to route recognised-but-mismatched
answers to review.

Student-visible feedback for a pass says explicitly that the command *"was checked statically, not
executed."* Nothing is ever run.

**Do we need a real Bash parser?** No. `shell-quote` tokenizes the supported subset (simple
commands, pipelines, redirections, quoting, operators) correctly, and a parser is not a semantic
equivalence engine — knowing that `grep -v` parses tells you nothing about whether it answers the
question. Everything outside the subset is detected and routed to review rather than guessed at.
`tree-sitter-bash` (~20 MB plus a native build) and `bash-parser` (unmaintained since 2022) were
evaluated and rejected; neither would change a single grading decision here.

### `rule` sandbox

`json-logic-js` has no `eval` and no function calls, but rules are still validated before being
stored *and* again before every run:

- operation allowlist (`ALLOWED_OPERATIONS`); `log` is explicitly denied so grading cannot write to
  the server console;
- `var` names must come from `RULE_DATA_KEYS`;
- ≤ 500 nodes, ≤ 20 nesting levels, ≤ 2000-character strings.

Facts available to a rule: `answer`, `normalized`, `lower`, `length`, `lines`, `lineCount`,
`words`, `number`, `isNumber`, `selected`, `selectedCount`, plus the shell analysis (`command`,
`commands`, `flags`, `rawFlags`, `operands`, `redirections`, `pipeSegments`, `parses`).

---

## 5. Honesty rules

The engine distinguishes *wrong* from *unknown*:

- An invalid **configuration** is rejected at authoring time (Zod + `safe-regex2` + rule validation),
  so a broken question can never be served.
- A **runtime** failure (a pattern or rule that throws despite validation) returns `needs_review`,
  never `incorrect`. An engine fault must not cost a student points.
- `error_type` is `none` for correct answers and `unclassified` whenever the evidence does not
  support a specific diagnosis. It is never guessed.
- Rates in analytics always travel with their `sample` and a `lowSample` flag (< 5 distinct
  questions). Trends require ≥ 3 distinct days and otherwise report `insufficient_data`.
- Answers awaiting review are excluded from accuracy denominators instead of counted wrong, and a
  result carries `provisional: true` while any review is outstanding.

---

## 6. Persistence

Additive columns (`ALTER TABLE ... ADD COLUMN`, guarded by `PRAGMA table_info`):

- `exercise_submissions`: `status`, `awarded_points`, `max_points`, `error_type`, `strategy`,
  `grading_version`, `explanation`, `difficulty`, `topic_id`, `question_type`, `attempt_number`,
  `duration_ms`, `hint_used`, `hint_count`.
- `student_answers`: the same grading columns (assessments have no retries, hints, or timing).

New table: `exercise_hint_usage` (per-section hint reveal count).

New read-only view `question_attempts` unions both sources into one attempt ledger. Legacy rows are
*interpreted* through `COALESCE` (a stored `score` becomes a status; missing points default to 1;
missing topic/type/difficulty are recovered from the frozen question snapshot) rather than being
rewritten. The view is dropped and recreated on every open, so it can evolve freely.

`grading_version` is a 12-hex-character SHA-256 fingerprint of the configuration, correct answer,
and question type. Editing a prompt does not change it; editing the answer key does — so historical
scores remain explainable after a question is edited.

### Backward compatibility

The legacy `score` column (0..1 fraction, `CHECK(score BETWEEN 0 AND 1)`) is still written exactly
as before, so every existing query, test, and export keeps working. Points are an additive layer:
legacy rows have `max_points = 1`, which makes the new points arithmetic identical to the old
fraction arithmetic. All 21 pre-existing tests pass unchanged.

---

## 7. MCP surface

Added tools:

| Tool | Purpose |
| --- | --- |
| `validate_grading_config` | Dry-run a config and see the exact outcome for sample answers. Writes nothing. |
| `get_learning_analytics` | Totals, first-attempt vs eventual accuracy, per-topic mastery, difficulty breakdown, common mistakes, trend. |
| `get_topic_analytics` | One topic in depth, including attempts-to-success and recent attempts. |
| `get_recent_attempts` | Raw attempt history with the student's actual answers. |
| `get_common_mistakes` | Error histogram plus repeatedly missed questions. |
| `get_pending_reviews` | Everything waiting on a human, oldest first. |

`upsert_question` gained `grading`, `retryPolicy`, `hintPolicy`, and `tags`.

---

## 8. Security assumptions

- The instructor (via MCP) is trusted to author content but **not** trusted to crash or hang the
  server: patterns are ReDoS-checked, rules are allowlisted and size-limited, and bash constraints
  are plain data.
- The student is untrusted. Student input is only ever compared, tokenized, or measured. It is
  never evaluated, interpolated into SQL (all queries are parameterised), or executed.
- `shell-quote` is invoked with an env function that *preserves* `$VAR` references instead of
  expanding them, so no host environment value can leak into grading output.
- Answer keys (`grading`, `correctAnswer`, `explanation`) are stripped server-side in
  `studentQuestion()`. The `grading` config is never sent to the browser at any point in the
  lifecycle, because accepted answers and rules *are* the answer key. Students receive only a
  `GradingSummary` (strategy name, points, attempts, hint availability).
- This is a single-student local application with no authentication. It should not be exposed to a
  network.

## 9. Known limitations

- `npm audit` reports a high-severity advisory for `zod < 4.6.6`. Upgrading is a breaking major
  change that would require rewriting every schema (the MCP SDK integration depends on the zod 3
  API). It is deliberately deferred and recorded here rather than silently patched.
- `bash_structure` understands structure, not semantics: it cannot tell that `ls -a` and
  `find . -maxdepth 1` are equivalent. Use `alternatives`, `acceptedAnswers`, or
  `onMismatch: "needs_review"`.
- `bash_structure` does not model variables, command substitution, subshells, loops or
  conditionals. Such answers are returned as `needs_review` rather than guessed at — correct ones
  cost an instructor a click, which is the right side to err on.
- Legacy `bash_structure` questions stored without `completeness` are read as `open`, so answers
  their rules do not fully describe now return `needs_review` instead of `correct`. Historical
  scores are untouched; nothing is regraded. Rewrite those questions with closed constraints
  (`exactFlags`/`positionalArguments`) to get definitive grading back.
- Regex patterns are capped at 1000 characters and rejected by `safe-regex2` if a repetition nests
  inside another repetition. Star-height analysis is conservative, so a few safe patterns (such as
  `(\d+\.){3}\d+`) are refused; the error message names the construct and points at
  `bash_structure` or `accepted_answers`, which are the better tools for those questions anyway.
- Response time is measured in the browser and is `null` for assessment answers and for any
  submission made outside the web UI.
- The accuracy trend is a plain least-squares line over daily first-attempt accuracy. It describes
  the recorded data; it is not a forecast.
