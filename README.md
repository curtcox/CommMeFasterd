# CommMeFasterd

Minimal first step for a Mac Electron multi-app communication shell.

## What this build includes
- Tabs for Slack, Teams, Office, Gmail, Google Calendar, Settings, and Database.
- Each non-Settings tab is an Electron `BrowserView` wrapper for the web app.
- Settings now supports:
  - LLM provider configuration (`OpenAI`, `Anthropic`, `Gemini`, `OpenRouter`) with API key/model/endpoint override
  - plain-text action definitions with schedules and generated inspectable code
  - plain-text trigger definitions with schedules, action mapping, generated inspectable code, and enable/disable controls
  - message simulation to test trigger/action behavior
  - trigger match history so you can inspect which past messages each trigger applied to
  - schedule inspector to see what triggers/actions are active at any past/future timestamp
- SQLite-backed storage:
  - app webview events (navigation/title/load/notification)
  - incoming/simulated messages
  - triggers, actions, schedules, evaluations, automation events
  - LLM settings
- Database tab:
  - inspect one DB table at a time via sub-tabs (`llm_settings`, `actions`, `triggers`, `messages`, `trigger_evaluations`, `automation_events`, `app_events`, `console_logs`, `http_traffic`, `screenshots`)
  - inspect database path and row counts
  - capture on-demand screenshots from wrapped app tabs
  - run read-only SQL queries (`SELECT`, `WITH`, `PRAGMA`, `EXPLAIN`)
- Basic active-tab introspection (`title`, `url`, loading, navigation state).

## Run
```bash
npm install
npm start
```

## Quick verification
1. Launch app.
2. Switch between Slack/Teams/Office/Gmail/Calendar tabs.
3. Open the `Settings` tab.
4. Save LLM settings (provider + API key/model).
5. Add one action and inspect its generated code.
6. Add one trigger linked to that action and inspect its generated code.
7. Run a simulated message and verify:
   - event stream updates
   - trigger history shows whether the trigger matched that message
8. Use schedule inspector with a past and future timestamp.
9. Open the `Database` tab, switch sub-tabs, and verify each table loads independently.
10. In `Database`, verify:
   - web console logs appear
   - HTTP traffic appears
   - screenshot capture works and stores metadata/history
