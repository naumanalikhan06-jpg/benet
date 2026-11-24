# BENET — The web, handled.

A polished, responsive frontend prototype for the hackathon challenge **“Beyond the Browser — Reimagine How We Use the Web.”**

## Run locally
1. Extract the ZIP.
2. Open `index.html` in a modern browser.
3. Type a mission or choose one of the suggested prompts.
4. Click **Run BENET** to see the simulated agent workflow.

The static interface and keyless web lookups run directly in a modern browser; no server runtime or provider API key is needed.

## Keyless web lookups
- BENET queries DuckDuckGo Instant Answers directly from the user's browser and falls back to short Wikipedia topic summaries; no API key or server proxy is used.
- Results include links to their sources. This is not a full-web-search or AI-synthesis service; current or unsupported questions receive a full-search link instead.
- Wikipedia excerpts are attributed to their linked articles and shared under CC BY-SA.
- The built-in example prompts return clearly labeled dummy answers and do not trigger a live lookup.
- Questions are sent to DuckDuckGo and, when needed, Wikipedia for lookup. Do not enter sensitive or private information.

## Hackathon submission alignment
- Submitted for **wHACKiest 2026 — Track 02: Beyond the Browser**
- The interface demonstrates browser-oriented intent, transparent execution, and human approval
- The first-round deliverables remain: PPT, 3–5 minute pitch video, GitHub repository and chosen track number

## What is demonstrated
- Intent-first mission composer
- Research, comparison, and web-action capability areas
- Agent execution trace with animated steps and progress
- Connected-context / source-intelligence panel
- Mission output and human-approval messaging
- Responsive dashboard layout and navigation

## Important prototype note
This is a **frontend-oriented submission prototype**. Mission progress and website actions are simulated locally. Keyless instant-answer lookups use DuckDuckGo; they do not browse arbitrary pages or guarantee a synthesized answer for every question. Do not present simulated workflow steps as real browser automation.

## Suggested next engineering milestones
1. Add a supported full-web-search provider if ranked results are required for every question.
2. Build a browser automation layer (e.g. Playwright) with domain allowlists.
3. Add source confidence and evidence snippets.
4. Require explicit user approval before form submission, purchases, account changes, or other consequential actions.

## Project positioning
**BENET** is an intent-first web operator: users describe the outcome they want, and the agent coordinates research, comparison, and task preparation into one transparent workflow — with the human in control of consequential actions.
