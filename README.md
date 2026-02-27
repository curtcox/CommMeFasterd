# CommMeFasterd

Minimal first step for a Mac Electron multi-app communication shell.

## What this first step includes
- Tabs for Slack, Teams, Office, Gmail, Google Calendar, and Settings.
- Each non-Settings tab is a dedicated Electron `BrowserView` wrapper for the site web app.
- Settings contains a small automation prototype:
  - define a rule for what to do when a message is received (`send_message`, `schedule_meeting`, `research_past_conversation`, `initiate_new_conversation`)
  - simulate incoming messages
  - see planned automation actions in an event stream
- Basic introspection panel for the active wrapped tab (`title`, `url`, navigation state).

## Run
```bash
npm install
npm start
```

## Quick verification
1. Launch app.
2. Switch between Slack/Teams/Office/Gmail/Calendar tabs.
3. Open the `Settings` tab.
4. Add an automation rule.
5. Run a simulated message and verify a new event appears in the event stream.
