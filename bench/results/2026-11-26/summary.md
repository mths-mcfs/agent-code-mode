Median (min–max) over valid runs. Input is uncached input tokens; Codex output includes reasoning tokens.

Requests are model requests counted from usage events; num_turns is the host counter (Claude counts tool-use rounds, so parallel tool calls inflate it). pass^n: every valid run of the cell passed. Cost/solved: cost of all valid runs, failed ones included, over the passing runs.

| Host | Task | Arm | Config | Pass@1 | Pass^n | Requests | num_turns | Input | Output | Cache write | Cache read | Cost | Cost/solved | Wall | Fallback | Valid/runs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude | T2 | B agent-code-mode (strict) | 5decbd736b3c | 100% | 100% | 4 | 4 | 8 | 571 (542–626) | 3487 (3477–3874) | 19354 (18957–19364) | $0.0442 ($0.0432–$0.0457) | $0.0444 | 20.3s (19.3s–22.1s) | 0% | 3/3 |
| claude | T2 | D Claude Code Code Mode (REPL, interactive) | abfb5bd3cde9 | 100% | 100% | 4 (4–5) | 4 (4–5) | 8 (8–10) | 518 (511–600) | 8165 (7780–8659) | 57447 (56618–73149) | $0.0889 ($0.0871–$0.0910) | $0.0890 | 24.8s (20.8s–25.0s) | 0% | 3/3 |

### Arms over all tasks

Cohort: runs whose configs differ only in task and arm. Pass@1 and cost/run are means over tasks (each task weighs the same); pass^k uses one k per cohort, the fewest valid runs of any cell, never more than the runs made.

| Host | Cohort | Arm | Tasks | Pass@1 | Pass^k | Cost/run | Cost/solved | Requests | num_turns | Valid/runs |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 6cba2497 | B agent-code-mode (strict) | 1 | 100% | 100% (k=3) | $0.0444 | $0.0444 | 4 | 4 | 3/3 |
| claude | 6cba2497 | D Claude Code Code Mode (REPL, interactive) | 1 | 100% | 100% (k=3) | $0.0890 | $0.0890 | 4 (4–5) | 4 (4–5) | 3/3 |

### Comparisons

Arm minus reference over the tasks both ran: estimate [95% CI], paired cluster bootstrap over tasks (10000 resamples, seed 20261116). An interval that crosses 0 does not show a difference.

| Host | Cohort | Arm vs reference | Tasks | Δ pass@1 | Δ cost/run |
|---|---|---|---|---|---|
| claude | 6cba2497 | D vs B | 1 | – (needs 2+ tasks) | – (needs 2+ tasks) |

Warmup: 2 run(s), $0.1614, kept under warmup/ and out of every number above.

<details><summary>Environment</summary>

```json
[
  {
    "startedAt": "2026-11-26T11:19:19.177Z",
    "dryRun": false,
    "seed": 580478811,
    "fixtureSeed": 1115,
    "fixtureSha256": "e8aee80fe0d34c5a38561d74cc1d850800ae134bc59ef55fe5cb3bb1a5e0c521",
    "runsPerArm": 3,
    "tasks": [
      "T2"
    ],
    "arms": [
      "B",
      "D"
    ],
    "schedule": "paired blocks (every arm of a host x task back to back), arm order rotated per round from a seeded base order",
    "warmup": "one T1 run per host x arm before the matrix, kept under warmup/ and out of the statistics",
    "baseline": null,
    "timeoutMin": 15,
    "hosts": {
      "claude": {
        "version": "2.1.332 (Claude Code)",
        "model": "claude-opus-5-5",
        "effort": "medium",
        "maxTurns": 60,
        "isolation": "--setting-sources project; --strict-mcp-config; CLAUDE_CODE_DISABLE_CLAUDE_MDS=1; CLAUDE_CODE_DISABLE_AUTO_MEMORY=1; temporary CLAUDE_CONFIG_DIR with a copy of .credentials.json (written back if refreshed)",
        "interactiveDriver": "tmux-v1: env -i allowlist, seeded .claude.json, bracketed paste, deny = No+Tab+note, end = transcript turn_duration + idle screen",
        "tmux": "tmux 3.8"
      }
    },
    "os": "linux 7.2 x64",
    "node": "v26.13.1",
    "agentCodeModeCommit": "17cfe809286786ef006eb2d494a7031371b42841",
    "agentCodeModeDirty": false,
    "surfaces": {
      "observed": {
        "claude/B": [
          "mcp__agent-code-mode__run"
        ],
        "claude/D": [
          "DeferredToolPlaceholder",
          "REPL",
          "REPL.Bash",
          "REPL.Edit",
          "REPL.EndConversation",
          "REPL.Glob",
          "REPL.Grep",
          "REPL.Read",
          "REPL.Write",
          "advisor"
        ]
      },
      "required": {
        "claude": {
          "A": [
            "Bash",
            "Read",
            "Write",
            "Edit",
            "Glob",
            "Grep"
          ],
          "B": [
            "mcp__agent-code-mode__run"
          ],
          "C": [
            "Bash",
            "Read",
            "Write",
            "Edit",
            "Glob",
            "Grep",
            "mcp__agent-code-mode__run"
          ],
          "D": [
            "REPL",
            "REPL.Bash",
            "REPL.Read",
            "REPL.Write",
            "REPL.Edit",
            "REPL.Glob",
            "REPL.Grep"
          ]
        },
        "codexNonFileTools": [
          "list_mcp_resource_templates",
          "list_mcp_resources",
          "read_mcp_resource",
          "request_user_input"
        ],
        "codexFeaturesOff": [
          "apps",
          "view_image",
          "image_generation",
          "goals",
          "multi_agent",
          "sleep_tool"
        ]
      }
    }
  }
]
```

</details>
