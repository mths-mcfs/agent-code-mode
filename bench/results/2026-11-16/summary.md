Median (min–max) over valid runs. Input is uncached input tokens; Codex output includes reasoning tokens.

| Host | Task | Arm | Config | Pass | Turns | Input | Output | Cache write | Cache read | Cost | Wall | Fallback | Valid/runs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude | T1 | A native tools | f777bc679f76 | 100% | 2 | 4 | 168 | 664 | 13701 | $0.0057 | 4.2s (4.1s–4.3s) | 0% | 3/3 |
| claude | T1 | B agent-code-mode (strict) | 83d190b8f21a | 100% | 2 | 4 | 118 | 1153 | 5947 | $0.0064 | 4.3s (4.2s–4.5s) | 0% | 3/3 |
| claude | T2 | A native tools | af3ac3e7b6d4 | 100% | 5 (5–6) | 10 | 441 (433–712) | 2161 (1789–2397) | 38094 (37486–38155) | $0.0178 ($0.0153–$0.0196) | 10.6s (10.2s–12.0s) | 0% | 3/3 |
| claude | T2 | B agent-code-mode (strict) | dc97b8efeda3 | 100% | 4 | 8 | 505 (502–522) | 4391 (4248–4648) | 18020 (17624–18174) | $0.0244 ($0.0239–$0.0256) | 9.2s (8.9s–9.3s) | 0% | 3/3 |
| claude | T3 | A native tools | 62be676d39da | 100% | 2 | 4 | 267 (187–280) | 623 (592–1254) | 13769 (13123–13769) | $0.0064 ($0.0057–$0.0091) | 4.7s (4.5s–5.6s) | 0% | 3/3 |
| claude | T3 | B agent-code-mode (strict) | 92a1a28eba89 | 100% | 2 | 4 | 218 (217–225) | 1430 (1288–1833) | 6015 (5579–6015) | $0.0085 ($0.0080–$0.0101) | 4.9s (4.8s–4.9s) | 0% | 3/3 |
| claude | T4 | A native tools | 1b9e3901d6c8 | 100% | 4 | 8 | 632 (623–634) | 1360 (1340–2041) | 29103 (28487–29163) | $0.0147 ($0.0146–$0.0173) | 8.0s (7.8s–8.1s) | 0% | 3/3 |
| claude | T4 | B agent-code-mode (strict) | 7dc1a71e6840 | 100% | 4 | 8 | 804 (791–845) | 5637 (5361–5983) | 15026 (14744–15035) | $0.0321 ($0.0314–$0.0333) | 9.9s (9.9s–10.6s) | 0% | 3/3 |
| claude | T5 | A native tools | d2d7c0c1808a | 100% | 3 | 6 | 410 (380–420) | 3234 (3201–3880) | 23327 (22698–23329) | $0.0193 ($0.0191–$0.0219) | 6.4s (6.3s–6.9s) | 0% | 3/3 |
| claude | T5 | B agent-code-mode (strict) | 5fc658748f82 | 100% | 3 | 6 | 456 (442–461) | 9566 (9521–9978) | 17551 (17144–17565) | $0.0446 ($0.0443–$0.0462) | 7.1s (7.0s–7.9s) | 0% | 3/3 |
| claude | T6 | A native tools | 706fd7c486de | 100% | 4 | 8 | 920 (809–1292) | 2252 (1532–2541) | 28914 (28717–29566) | $0.0223 ($0.0171–$0.0249) | 10.5s (10.4s–12.3s) | 0% | 3/3 |
| claude | T6 | B agent-code-mode (strict) | e79301f51090 | 100% | 6 (5–6) | 10 | 1382 (1310–1396) | 29075 (28865–29949) | 62561 (60998–64712) | $0.1365 ($0.1347–$0.1401) | 16.1s (15.8s–16.5s) | 0% | 3/3 |
| claude | T7 | A native tools | a8cf9f4b9f45 | 100% | 4 | 8 | 579 (574–629) | 3906 (3812–4055) | 32394 (31681–32503) | $0.0248 ($0.0246–$0.0252) | 8.3s (7.8s–9.3s) | 0% | 3/3 |
| claude | T7 | B agent-code-mode (strict) | d54ecb42629a | 100% | 4 | 8 | 916 (901–919) | 4675 (4665–5093) | 15813 (15472–15874) | $0.0295 ($0.0293–$0.0311) | 10.4s (10.3s–10.8s) | 0% | 3/3 |
| claude | T8 | A native tools | 5ebcfee5a1a2 | 100% | 22 | 8 | 3912 (3886–3920) | 6886 (6884–7595) | 32245 (31600–32247) | $0.0700 ($0.0696–$0.0727) | 21.4s (21.0s–21.7s) | 0% | 3/3 |
| claude | T8 | B agent-code-mode (strict) | 729e93cfb0c8 | 100% | 3 | 6 | 484 (483–498) | 6017 (6008–6513) | 12386 (11918–12386) | $0.0303 ($0.0301–$0.0321) | 8.4s (8.0s–8.7s) | 0% | 3/3 |
| codex | T1 | A native tools (direct) | 1a699b6f9ec8 | 100% | 2 | 5613 (5554–10673) | 63 (53–112) | 0 | 15360 (10240–15360) | $0.0069 ($0.0066–$0.0115) | 6.3s (6.1s–6.8s) | 0% | 3/3 |
| codex | T1 | B Codex code mode | 167d8ff9ba82 | 100% | 2 | 5556 (5556–12341) | 61 (61–62) | 0 | 18688 (11904–18688) | $0.0068 ($0.0068–$0.0132) | 7.5s (7.1s–8.1s) | 0% | 3/3 |
| codex | T1 | C agent-code-mode (strict) | 5faef56921d7 | 100% | 2 | 10539 (5675–10791) | 66 (62–66) | 0 | 9984 (9728–14848) | $0.0114 ($0.0067–$0.0116) | 6.0s (5.5s–6.2s) | 0% | 3/3 |
| codex | T2 | A native tools (direct) | 9420f03f441e | 100% | 8 (7–8) | 17951 (8766–28546) | 570 (398–630) | 0 | 93440 (73472–104832) | $0.0260 ($0.0144–$0.0364) | 20.7s (18.1s–24.3s) | 0% | 3/3 |
| codex | T2 | B Codex code mode | ae9e6a4913bf | 100% | 6 (5–6) | 31731 (23724–39442) | 817 (777–867) | 0 | 78848 (50176–89600) | $0.0400 ($0.0321–$0.0460) | 23.1s (21.6s–24.7s) | 0% | 3/3 |
| codex | T2 | C agent-code-mode (strict) | 7d43bb737337 | 100% | 5 (4–5) | 17378 (9496–29568) | 645 (576–863) | 0 | 39296 (39040–52224) | $0.0232 ($0.0143–$0.0358) | 21.5s (20.0s–23.9s) | 0% | 3/3 |
| codex | T3 | A native tools (direct) | 89f1358acbae | 100% | 2 | 5492 (5491–5581) | 127 (88–127) | 0 | 15488 (15360–15488) | $0.0069 ($0.0068–$0.0069) | 7.7s (6.5s–8.0s) | 0% | 3/3 |
| codex | T3 | B Codex code mode | 058298631841 | 100% | 2 | 6988 (5582–12376) | 106 (96–153) | 0 | 18688 (11904–18816) | $0.0087 ($0.0070–$0.0135) | 6.9s (6.7s–7.8s) | 0% | 3/3 |
| codex | T3 | C agent-code-mode (strict) | 7eb9f9e293ce | 100% | 3 (3–4) | 7999 (6435–11000) | 226 (170–265) | 0 | 25600 (20608–36096) | $0.0106 ($0.0094–$0.0129) | 10.2s (9.4s–10.5s) | 0% | 3/3 |
| codex | T4 | A native tools (direct) | 48f36a4339f5 | 100% | 4 | 11665 (7984–13275) | 269 (244–284) | 0 | 35200 (32000–40192) | $0.0145 ($0.0113–$0.0165) | 12.4s (11.7s–12.5s) | 0% | 3/3 |
| codex | T4 | B Codex code mode | 3758fe742a37 | 100% | 4 | 14590 (6736–14769) | 312 (296–371) | 0 | 40192 (40192–43904) | $0.0181 ($0.0105–$0.0186) | 13.3s (13.0s–14.7s) | 0% | 3/3 |
| codex | T4 | C agent-code-mode (strict) | b2aefa120e2b | 100% | 6 | 13513 (10166–14799) | 455 (435–471) | 0 | 54656 (54144–61824) | $0.0186 ($0.0154–$0.0198) | 18.9s (16.4s–20.1s) | 0% | 3/3 |
| codex | T5 | A native tools (direct) | 15474b1e7171 | 100% | 4 (4–5) | 16169 (14907–23788) | 323 (298–328) | 0 | 37888 (29056–50176) | $0.0203 ($0.0183–$0.0269) | 13.6s (12.0s–15.3s) | 0% | 3/3 |
| codex | T5 | B Codex code mode | e04b4b8817b5 | 100% | 4 | 16553 (9794–25492) | 390 (385–558) | 0 | 43008 (38272–49664) | $0.0206 ($0.0142–$0.0302) | 16.7s (12.8s–17.8s) | 0% | 3/3 |
| codex | T5 | C agent-code-mode (strict) | ae004a1c70d6 | 100% | 3 (3–4) | 10292 (10165–18225) | 300 (292–461) | 0 | 28928 (28800–34560) | $0.0132 ($0.0131–$0.0223) | 13.8s (12.3s–18.9s) | 0% | 3/3 |
| codex | T6 | A native tools (direct) | 95992ee41313 | 100% | 5 (4–5) | 10229 (9661–17107) | 643 (565–784) | 0 | 53888 (38144–54784) | $0.0163 ($0.0157–$0.0222) | 21.1s (20.8s–24.9s) | 0% | 3/3 |
| codex | T6 | B Codex code mode | bf75de8d3d31 | 100% | 4 (3–5) | 17258 (12265–18332) | 684 (661–707) | 0 | 41216 (29312–66048) | $0.0220 ($0.0191–$0.0238) | 20.0s (19.7s–25.3s) | 0% | 3/3 |
| codex | T6 | C agent-code-mode (strict) | ef53bd175140 | 100% | 6 (5–7) | 11766 (10124–16149) | 1260 (868–1594) | 0 | 70912 (48640–84736) | $0.0229 ($0.0200–$0.0240) | 35.5s (27.5s–40.8s) | 0% | 3/3 |
| codex | T7 | A native tools (direct) | f2509ca681b6 | 100% | 8 (7–10) | 19849 (15562–35347) | 780 (762–812) | 0 | 124416 (99456–131840) | $0.0299 ($0.0244–$0.0460) | 25.9s (25.1s–30.5s) | 0% | 3/3 |
| codex | T7 | B Codex code mode | 202f49d5f824 | 100% | 5 | 17528 (16836–23434) | 854 (799–915) | 0 | 77952 (74240–79616) | $0.0258 ($0.0247–$0.0317) | 25.2s (24.2s–25.8s) | 0% | 3/3 |
| codex | T7 | C agent-code-mode (strict) | efdd16ace6e0 | 100% | 4 | 19178 (12715–19879) | 718 (566–733) | 0 | 41856 (41216–43264) | $0.0249 ($0.0177–$0.0255) | 21.6s (18.5s–21.6s) | 0% | 3/3 |
| codex | T8 | A native tools (direct) | 253baf6a0d99 | 100% | 5 (5–6) | 13083 (9586–13359) | 695 (695–927) | 0 | 45440 (44672–62848) | $0.0188 ($0.0174–$0.0191) | 24.1s (21.3s–27.7s) | 0% | 3/3 |
| codex | T8 | B Codex code mode | 6d3ddd9a7ad4 | 100% | 5 (5–6) | 12634 (10813–13289) | 644 (631–871) | 0 | 66432 (66304–85888) | $0.0198 ($0.0173–$0.0213) | 23.1s (20.0s–34.5s) | 0% | 3/3 |
| codex | T8 | C agent-code-mode (strict) | 962e4d579e34 | 100% | 4 (3–4) | 9908 (8429–19257) | 372 (334–408) | 0 | 38400 (14976–38912) | $0.0137 ($0.0124–$0.0217) | 14.3s (14.0s–14.7s) | 0% | 3/3 |

<details><summary>Environment</summary>

```json
[
  {
    "startedAt": "2026-11-16T01:46:30.710Z",
    "dryRun": false,
    "seed": 20261115,
    "fixtureSeed": 1115,
    "fixtureSha256": "e8aee80fe0d34c5a38561d74cc1d850800ae134bc59ef55fe5cb3bb1a5e0c521",
    "runsPerArm": 3,
    "tasks": [
      "T1",
      "T2",
      "T3",
      "T4",
      "T5",
      "T6",
      "T7",
      "T8"
    ],
    "arms": [
      "A",
      "B"
    ],
    "timeoutMin": 15,
    "hosts": {
      "claude": {
        "version": "2.1.325 (Claude Code)",
        "model": "claude-sonnet-5-5",
        "effort": "medium",
        "maxTurns": 60,
        "isolation": "--setting-sources project; --strict-mcp-config; CLAUDE_CODE_DISABLE_CLAUDE_MDS=1; CLAUDE_CODE_DISABLE_AUTO_MEMORY=1; temporary CLAUDE_CONFIG_DIR with a copy of .credentials.json (written back if refreshed)"
      }
    },
    "os": "linux 7.2 x64",
    "node": "v26.13.0",
    "agentCodeModeCommit": "35260ce7807bef3b1a3f33bc1a0a80638026263d",
    "agentCodeModeDirty": false,
    "surfaces": {
      "observed": {
        "claude/A": [
          "Bash",
          "Edit",
          "Glob",
          "Grep",
          "Read",
          "Write"
        ],
        "claude/B": [
          "mcp__agent-code-mode__run"
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
  },
  {
    "startedAt": "2026-11-16T01:54:01.827Z",
    "dryRun": false,
    "seed": 20261115,
    "fixtureSeed": 1115,
    "fixtureSha256": "e8aee80fe0d34c5a38561d74cc1d850800ae134bc59ef55fe5cb3bb1a5e0c521",
    "runsPerArm": 3,
    "tasks": [
      "T1",
      "T2",
      "T3",
      "T4",
      "T5",
      "T6",
      "T7",
      "T8"
    ],
    "arms": [
      "A",
      "B",
      "C"
    ],
    "timeoutMin": 15,
    "hosts": {
      "codex": {
        "version": "codex-cli 0.169.0",
        "model": "gpt-6.1-terra",
        "effort": "medium",
        "maxTurns": null,
        "catalogSha256": "6fa0775ebcaa7e78ae147765ccd5d5b77e7991f42b55ae75a3daa704ab6dfbd8"
      }
    },
    "os": "linux 7.2 x64",
    "node": "v26.13.0",
    "agentCodeModeCommit": "35260ce7807bef3b1a3f33bc1a0a80638026263d",
    "agentCodeModeDirty": false,
    "surfaces": {
      "observed": {
        "codex/A": [
          "functions.apply_patch",
          "functions.exec_command",
          "functions.list_mcp_resource_templates",
          "functions.list_mcp_resources",
          "functions.read_mcp_resource",
          "functions.request_user_input",
          "functions.write_stdin"
        ],
        "codex/B": [
          "exec.apply_patch",
          "exec.exec_command",
          "exec.list_mcp_resource_templates",
          "exec.list_mcp_resources",
          "exec.read_mcp_resource",
          "exec.write_stdin",
          "functions.exec",
          "functions.request_user_input",
          "functions.wait"
        ],
        "codex/C": [
          "functions.list_mcp_resource_templates",
          "functions.list_mcp_resources",
          "functions.read_mcp_resource",
          "functions.request_user_input",
          "mcp__agent_code_mode.run"
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
