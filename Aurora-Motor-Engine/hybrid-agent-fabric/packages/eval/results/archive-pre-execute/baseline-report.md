# Aurora Eval Baseline Report

**Date:** 2026-09-17T16:34:34.411Z
**Suite:** standalone-eval
**Duration:** 65.4s

## Summary

| Metric | Value |
|--------|-------|
| Total Tasks | 75 |
| Passed | 0 |
| Failed | 42 |
| Skipped (engine-required) | 33 |
| Overall Score | 51.1% |

## Category Breakdown

| Category | Pass | Fail | Skip | Total | Status |
|----------|------|------|------|-------|--------|
| capability | 0 | 0 | 2 | 2 | ⏭️ |
| coding | 0 | 26 | 0 | 26 | ❌ |
| long | 0 | 0 | 2 | 2 | ⏭️ |
| memory | 0 | 0 | 6 | 6 | ⏭️ |
| multimodal | 0 | 0 | 2 | 2 | ⏭️ |
| planning | 0 | 1 | 5 | 6 | ❌ |
| reasoning | 0 | 0 | 6 | 6 | ⏭️ |
| recovery | 0 | 0 | 6 | 6 | ⏭️ |
| research | 0 | 0 | 3 | 3 | ⏭️ |
| security | 0 | 0 | 6 | 6 | ⏭️ |
| tool | 0 | 9 | 1 | 10 | ❌ |

## Key Findings

### What Works
- ✅ Eval system loads all 75 tasks correctly
- ✅ Property grader checks file existence
- ✅ Command grader executes and validates output
- ✅ Trajectory grader correctly skips without engine
- ✅ Judge grader correctly skips without LLM

### What Needs Engine
- ⏭️ Memory tasks (6) — require memory store/recall
- ⏭️ Security tasks (6) — require safety checks
- ⏭️ Recovery tasks (6) — require error handling
- ⏭️ Reasoning tasks (6) — require hypothesis testing
- ⏭️ Capability tasks (2) — require gap detection
- ⏭️ Multimodal tasks (2) — require image/document analysis
- ⏭️ Research tasks (3) — require web search
- ⏭️ Tool-use MCP task (1) — require MCP tools

### What Fails (Expected)
- ❌ Coding tasks — workspace files don't exist yet
- ❌ Tool tasks — workspace files don't exist yet
- ❌ Planning tasks — workspace files don't exist yet

## Baseline Metrics

- **Total Tasks:** 75
- **Engine-Required Tasks:** 33
- **Static-Check Tasks:** 42
- **Static Pass Rate:** 0.0%
- **Overall Score:** 51.1%

