---
name: Bug report
about: Something isn't working (no logs written, crash, wrong output)
title: ''
labels: bug
assignees: ''
---

**What happened**
A clear description of the bug.

**Expected behavior**
What you expected instead.

**Steps to reproduce**
1.
2.

**Environment**
- OS:
- Node version (`node --version`):
- Mode: official / local
- ps-local commit (`git rev-parse --short HEAD`):

**Logs**
Run with `PS_LOG_LEVEL=DEBUG` and paste relevant lines from `logs/debug/` (redact anything sensitive).
For "no log written" issues, include the tap status from DevTools console
(`[PSH inject] WebSocket created: … | tapped: …`).
